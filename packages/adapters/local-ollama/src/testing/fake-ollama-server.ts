// SPDX-License-Identifier: MPL-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A model loaded in memory, as `GET /api/ps` lists it. */
export interface FakeLoadedModel {
  readonly name: string;
  /** `context_length`; left out of the answer when `undefined` (a server older than the field). */
  readonly contextLength?: number;
}

/**
 * What the fake Ollama does. Field names of the answers follow `docs/api.md` of ollama/ollama and
 * https://docs.ollama.com/api/ps (read on 2026-11-16).
 */
export interface FakeOllamaBehavior {
  /**
   * `ready`: `/api/version`, `/` and `/api/tags` answer 200. `loading`: they answer 503 (the
   * signal the adapter reads as "up, not ready"; Ollama itself has no such state [N]).
   */
  health: 'ready' | 'loading';
  /** Names listed by `/api/tags` (installed models). */
  installed: readonly string[];
  /** `/api/ps`: the models loaded now, or 404 for a server without the endpoint. */
  loaded: readonly FakeLoadedModel[] | 'absent';
  /**
   * `none`: answers as described. `malformed`: 200 with a body that is not JSON. `wrong-shape`:
   * 200 with JSON of another shape. `error`: HTTP 500. `hang`: never answers. `huge`: a body over
   * the adapter's limit. `redirect`: 302 to another address.
   */
  fault: 'none' | 'malformed' | 'wrong-shape' | 'error' | 'hang' | 'huge' | 'redirect';
}

export const DEFAULT_BEHAVIOR: FakeOllamaBehavior = {
  health: 'ready',
  installed: ['model:latest'],
  loaded: [],
  fault: 'none',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function details(): unknown {
  return {
    parent_model: '',
    format: 'gguf',
    family: 'gemma',
    families: ['gemma'],
    parameter_size: '7.5B',
    quantization_level: 'Q4_0',
  };
}

/**
 * A stand-in for Ollama over real HTTP, on `127.0.0.1` and an ephemeral port. Tests set
 * `behavior` between calls; `requests` records `<METHOD> <path>` lines. Always `close()` it.
 */
export class FakeOllamaServer {
  behavior: FakeOllamaBehavior;
  readonly requests: string[] = [];
  readonly #server: Server;
  readonly url: string;

  private constructor(server: Server, port: number, behavior: FakeOllamaBehavior) {
    this.#server = server;
    this.behavior = behavior;
    this.url = `http://127.0.0.1:${String(port)}`;
  }

  static async start(behavior: Partial<FakeOllamaBehavior> = {}): Promise<FakeOllamaServer> {
    const merged = { ...DEFAULT_BEHAVIOR, ...behavior };
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const fake = new FakeOllamaServer(server, (server.address() as AddressInfo).port, merged);
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
        res.end('<html>this is not Ollama</html>');
        return;
      case 'wrong-shape':
        json(res, 200, { unexpected: true });
        return;
      case 'error':
        json(res, 500, { error: 'boom' });
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
    const probe = path === '/' || path === '/api/version' || path === '/api/tags';
    if (probe && b.health === 'loading') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    }
    switch (path) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Ollama is running');
        return;
      case '/api/version':
        json(res, 200, { version: '0.0.0-fake' });
        return;
      case '/api/tags':
        json(res, 200, {
          models: b.installed.map((name) => ({
            name,
            model: name,
            modified_at: '2026-11-16T00:00:00Z',
            size: 4_590_807_392,
            digest: 'sha256:0000',
            details: details(),
          })),
        });
        return;
      case '/api/ps':
        if (b.loaded === 'absent') {
          json(res, 404, { error: 'page not found' });
          return;
        }
        json(res, 200, {
          models: b.loaded.map((model) => ({
            name: model.name,
            model: model.name,
            size: 5_000_000_000,
            digest: 'sha256:0000',
            details: details(),
            expires_at: '2026-11-16T12:00:00Z',
            size_vram: 5_000_000_000,
            ...(model.contextLength === undefined ? {} : { context_length: model.contextLength }),
          })),
        });
        return;
      default:
        json(res, 404, { error: 'page not found' });
    }
  }
}
