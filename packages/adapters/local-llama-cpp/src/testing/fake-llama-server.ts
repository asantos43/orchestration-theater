// SPDX-License-Identifier: MPL-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * What the fake `llama-server` does. Field names of the answers follow the llama.cpp server
 * README (`tools/server/README.md` in ggml-org/llama.cpp, read on 2026-11-16).
 */
export interface FakeLlamaBehavior {
  /** `/health`: 200 `{"status":"ok"}` when ready; 503 "Loading model" while loading. */
  health: 'ready' | 'loading';
  /** Ids listed by `/v1/models`. */
  models: readonly string[];
  /** `/props`: `total_slots`, and `default_generation_settings.n_ctx` (the context of ONE slot). */
  props: { totalSlots?: number; nCtx?: number } | 'absent';
  /** `/slots`: an array of slots with their `n_ctx`, or 501 when started with `--no-slots`. */
  slots: { count: number; nCtx: number } | 'disabled' | 'absent';
  /**
   * `none`: answers as described. `malformed`: 200 with a body that is not JSON. `wrong-shape`:
   * 200 with JSON of another shape. `error`: HTTP 500. `hang`: never answers. `huge`: a body over
   * the adapter's limit. `redirect`: 302 to another address.
   */
  fault: 'none' | 'malformed' | 'wrong-shape' | 'error' | 'hang' | 'huge' | 'redirect';
}

export const DEFAULT_BEHAVIOR: FakeLlamaBehavior = {
  health: 'ready',
  models: ['model.gguf'],
  props: { totalSlots: 1, nCtx: 4096 },
  slots: { count: 1, nCtx: 4096 },
  fault: 'none',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function slotJson(id: number, nCtx: number): unknown {
  return { id, id_task: -1, n_ctx: nCtx, speculative: false, is_processing: false, params: {} };
}

/**
 * A stand-in for `llama-server` over real HTTP, on `127.0.0.1` and an ephemeral port. Tests set
 * `behavior` between calls; `requests` records `GET <path>` lines. Always `close()` it.
 */
export class FakeLlamaServer {
  behavior: FakeLlamaBehavior;
  readonly requests: string[] = [];
  readonly #server: Server;
  readonly url: string;

  private constructor(server: Server, port: number, behavior: FakeLlamaBehavior) {
    this.#server = server;
    this.behavior = behavior;
    this.url = `http://127.0.0.1:${String(port)}`;
  }

  static async start(behavior: Partial<FakeLlamaBehavior> = {}): Promise<FakeLlamaServer> {
    const merged = { ...DEFAULT_BEHAVIOR, ...behavior };
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const fake = new FakeLlamaServer(server, (server.address() as AddressInfo).port, merged);
    server.on('request', (req, res) => {
      fake.#handle(req, res);
    });
    return fake;
  }

  /** Stops the server and drops every open connection, including the ones that hang. */
  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    this.requests.push(`${req.method ?? '?'} ${path}`);
    const b = this.behavior;
    switch (b.fault) {
      case 'hang':
        return;
      case 'malformed':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>this is not llama-server</html>');
        return;
      case 'wrong-shape':
        json(res, 200, { unexpected: true });
        return;
      case 'error':
        json(res, 500, { error: { code: 500, message: 'boom', type: 'server_error' } });
        return;
      case 'huge':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
        return;
      case 'redirect':
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        res.end();
        return;
      case 'none':
        break;
    }
    switch (path) {
      case '/health':
        if (b.health === 'loading') {
          json(res, 503, {
            error: { code: 503, message: 'Loading model', type: 'unavailable_error' },
          });
        } else {
          json(res, 200, { status: 'ok' });
        }
        return;
      case '/v1/models':
        json(res, 200, {
          object: 'list',
          data: b.models.map((id) => ({
            id,
            object: 'model',
            created: 1735142223,
            owned_by: 'llamacpp',
            meta: { n_ctx_train: 131072 },
          })),
        });
        return;
      case '/props':
        if (b.props === 'absent') {
          this.#notFound(res);
          return;
        }
        json(res, 200, {
          ...(b.props.totalSlots === undefined ? {} : { total_slots: b.props.totalSlots }),
          default_generation_settings:
            b.props.nCtx === undefined ? {} : { id: 0, n_ctx: b.props.nCtx },
          build_info: 'b9999-fake',
        });
        return;
      case '/slots':
        if (b.slots === 'absent') {
          this.#notFound(res);
        } else if (b.slots === 'disabled') {
          json(res, 501, {
            error: {
              code: 501,
              message: 'This server does not support slots endpoint.',
              type: 'not_supported_error',
            },
          });
        } else {
          const { count, nCtx } = b.slots;
          json(
            res,
            200,
            Array.from({ length: count }, (_, id) => slotJson(id, nCtx)),
          );
        }
        return;
      default:
        this.#notFound(res);
    }
  }

  #notFound(res: ServerResponse): void {
    json(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
  }
}
