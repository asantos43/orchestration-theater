// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { AdapterUnavailable, type TelemetryBatch, type TelemetryStore } from '@otheater/core';
import type { TelemetryBatchRejectReason } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { decodeOtlp, OtlpDecodeError, type OtlpSignal } from './otlp.js';
import type { Redactor } from './redaction.js';
import type { TelemetrySessions } from './sessions.js';

/**
 * The OTLP/HTTP receiver of the daemon (Phase 8, P2, N211 to N213; architecture 5.11): the one door
 * the clients' telemetry comes in through. [proposta] Where the pieces were decided:
 * - **Loopback only**, on a port of its own (`telemetry.receiver.port`), apart from the API and the
 *   MCP server: it is a different trust (a client process, not a person) and a different load.
 * - **One token per boot** of the daemon, checked in `Authorization: Bearer <token>`; the clients
 *   get it through `OTEL_EXPORTER_OTLP_HEADERS` (see `client-telemetry.ts`). The token never reaches
 *   a log, an event or the telemetry base.
 * - **No CORS and no Origin**: a request that carries `Origin` is a browser's and is refused, and
 *   so is a `Host` that is not the loopback (DNS rebinding), as the MCP server does.
 * - **JSON only** (N211 (a)): a protobuf body is a 415 (the clients are asked for `http/json`), and
 *   so is any other content type or encoding. `gzip` is read with `node:zlib`.
 * - **A bounded body**: `telemetry.receiver.max_body`, for the bytes on the wire and for what gzip
 *   expands to (a bomb is a 413, not a memory problem).
 * - The status codes: 401 token, 403 origin or host, 404 path, 405 method, 413 size, 415 format of
 *   the body (type or encoding), 400 a body that is not OTLP/JSON, 200 `{}` accepted.
 *
 * What is accepted is correlated (see `TelemetrySessions`), redacted (see `Redactor`) and handed to
 * the `TelemetryStore`, whose `write` never throws and never waits for the disk. A refused batch is
 * counted and told in `telemetry.batch_rejected`, once a window per reason and signal, with no body.
 */

/** The only address the receiver listens on. */
export const RECEIVER_HOST = '127.0.0.1';

const SIGNAL_PATHS: Readonly<Record<string, OtlpSignal>> = {
  '/v1/traces': 'traces',
  '/v1/metrics': 'metrics',
  '/v1/logs': 'logs',
};

export interface TelemetryReceiverOptions {
  readonly store: Pick<TelemetryStore, 'write'>;
  readonly sessions: TelemetrySessions;
  readonly redactor: Redactor;
  /** `'auto'` takes a free port at each start; a number is that port. */
  readonly port: 'auto' | number;
  /** Largest body, on the wire and after gunzip, in bytes. */
  readonly maxBody: number;
  /** The token; default a fresh one (32 random bytes, `base64url`). */
  readonly token?: string;
  readonly logger: Logger;
  /** Where `telemetry.receiver_started`, `telemetry.batch_rejected` and `telemetry.redacted` go. */
  readonly situations?: SituationSink;
  /** The window the rejected and redacted counts are told in. Default one minute. */
  readonly windowMs?: number;
}

/**
 * What the receiver took and refused since it started (Phase 8, P10, [proposta]): whole batches, by
 * signal and by reason. Unlike the windows that are told in `telemetry.batch_rejected` and then
 * cleared, these only grow, so a screen can show them at any moment. No body, no token.
 */
export interface TelemetryReceiverStats {
  readonly accepted: Readonly<Record<OtlpSignal, number>>;
  readonly rejected: Readonly<Record<TelemetryBatchRejectReason, number>>;
}

const gunzipAsync = promisify(gunzip);

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/** A request was refused: the status, and the reason that is counted. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: TelemetryBatchRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

export class TelemetryReceiver {
  readonly #server: Server;
  readonly #options: TelemetryReceiverOptions;
  readonly #token: string;
  readonly #tokenDigest: Buffer;
  readonly #rejected = new Map<
    string,
    { reason: TelemetryBatchRejectReason; signal: OtlpSignal | null; count: number }
  >();
  readonly #acceptedTotal: Record<OtlpSignal, number> = { traces: 0, metrics: 0, logs: 0 };
  readonly #rejectedTotal: Record<TelemetryBatchRejectReason, number> = {
    format: 0,
    size: 0,
    token: 0,
  };
  #port = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  private constructor(options: TelemetryReceiverOptions) {
    this.#options = options;
    this.#token = options.token ?? randomBytes(32).toString('base64url');
    this.#tokenDigest = digest(this.#token);
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server.requestTimeout = 30_000;
    this.#server.headersTimeout = 10_000;
  }

  /**
   * Starts listening on the loopback. With a fixed port that is taken, or when the system refuses,
   * rejects with `AdapterUnavailable`; the daemon then goes on without telemetry.
   */
  static async start(options: TelemetryReceiverOptions): Promise<TelemetryReceiver> {
    const receiver = new TelemetryReceiver(options);
    await receiver.#listen();
    receiver.#timer = setInterval(() => {
      receiver.flushSituations();
    }, options.windowMs ?? 60_000);
    receiver.#timer.unref();
    options.logger.info({ port: receiver.#port }, 'OTLP telemetry receiver listening');
    options.situations?.record('telemetry.receiver_started', { port: receiver.#port });
    return receiver;
  }

  #listen(): Promise<void> {
    const wanted = this.#options.port === 'auto' ? 0 : this.#options.port;
    return new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(
          new AdapterUnavailable(
            error.code === 'EADDRINUSE'
              ? `The telemetry receiver port ${String(wanted)} is already in use`
              : `The telemetry receiver could not listen on ${RECEIVER_HOST}: ${error.message}`,
          ),
        );
      };
      this.#server.once('error', onError);
      this.#server.listen(wanted, RECEIVER_HOST, () => {
        this.#server.off('error', onError);
        this.#port = (this.#server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  /** The base URL a client posts to (`<url>/v1/<signal>`). */
  get url(): string {
    return `http://${RECEIVER_HOST}:${String(this.#port)}`;
  }

  /** The token of this boot. The daemon hands it to the clients and to nobody else. */
  get token(): string {
    return this.#token;
  }

  /** The batches taken and refused since the start (cumulative, unlike the windows of the events). */
  get stats(): TelemetryReceiverStats {
    return { accepted: { ...this.#acceptedTotal }, rejected: { ...this.#rejectedTotal } };
  }

  /** Tells what was refused and what was redacted since the last window, now. */
  flushSituations(): void {
    const sink = this.#options.situations;
    const rejected = [...this.#rejected.values()];
    this.#rejected.clear();
    const redacted = this.#options.redactor.drain();
    if (sink === undefined) return;
    for (const item of rejected) sink.record('telemetry.batch_rejected', item);
    if (redacted !== undefined) {
      sink.record('telemetry.redacted', {
        mode: redacted.mode,
        count: redacted.count,
        records: redacted.records,
        names: redacted.names.slice(0, 64).map((name) => name.slice(0, 128)),
      });
    }
  }

  /** Stops listening, closes the connections and tells the last window. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await closeServer(this.#server);
    this.flushSituations();
  }

  #reject(signal: OtlpSignal | null, refusal: Refusal): void {
    this.#rejectedTotal[refusal.reason] += 1;
    const key = `${refusal.reason}|${signal ?? ''}`;
    const known = this.#rejected.get(key);
    if (known === undefined) this.#rejected.set(key, { reason: refusal.reason, signal, count: 1 });
    else known.count += 1;
  }

  #authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (header === undefined) return false;
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (match?.[1] === undefined) return false;
    return timingSafeEqual(digest(match[1]), this.#tokenDigest);
  }

  #hostAllowed(request: IncomingMessage): boolean {
    const port = String(this.#port);
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
      (request.headers.host ?? '').toLowerCase(),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let signal: OtlpSignal | null = null;
    try {
      const path = (request.url ?? '').split('?')[0] ?? '';
      signal = SIGNAL_PATHS[path] ?? null;
      if (request.headers.origin !== undefined || !this.#hostAllowed(request)) {
        throw new Refusal(403, 'token', 'forbidden');
      }
      if (!this.#authorized(request)) throw new Refusal(401, 'token', 'unauthorized');
      if (signal === null) throw new Refusal(404, 'format', 'not found');
      if (request.method !== 'POST') throw new Refusal(405, 'format', 'method not allowed');
      const batch = await this.#read(request, signal);
      this.#accept(batch);
      this.#acceptedTotal[signal] += 1;
      this.#send(response, 200, {});
    } catch (error) {
      if (error instanceof Refusal) {
        this.#reject(signal, error);
        this.#send(response, error.status, { code: error.status, message: error.message }, true);
        if (error.status === 413) response.once('finish', () => request.destroy());
        return;
      }
      this.#options.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'telemetry receiver failed on a batch',
      );
      this.#send(response, 500, { code: 500, message: 'internal error' }, true);
    }
  }

  async #read(request: IncomingMessage, signal: OtlpSignal): Promise<TelemetryBatch> {
    const limit = this.#options.maxBody;
    const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      throw new Refusal(415, 'format', 'only application/json is accepted (OTLP/HTTP JSON)');
    }
    const encoding = (request.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && encoding !== 'gzip') {
      throw new Refusal(415, 'format', 'only gzip or no content-encoding is accepted');
    }
    const announced = Number(request.headers['content-length']);
    if (Number.isFinite(announced) && announced > limit) {
      throw new Refusal(413, 'size', 'the body is larger than telemetry.receiver.max_body');
    }
    let raw = await this.#collect(request, limit);
    if (encoding === 'gzip') {
      try {
        raw = await gunzipAsync(raw, { maxOutputLength: limit });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Refusal(413, 'size', 'the body is larger than telemetry.receiver.max_body');
        }
        throw new Refusal(400, 'format', 'the body is not valid gzip');
      }
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Refusal(400, 'format', 'the body is not valid JSON');
    }
    try {
      return decodeOtlp(signal, json);
    } catch (error) {
      if (error instanceof OtlpDecodeError) throw new Refusal(400, 'format', error.message);
      throw error;
    }
  }

  async #collect(request: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > limit) {
        throw new Refusal(413, 'size', 'the body is larger than telemetry.receiver.max_body');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  /** Correlates, redacts and hands the records to the store. */
  #accept(batch: TelemetryBatch): void {
    const { sessions, redactor, store } = this.#options;
    const correlated: TelemetryBatch = {
      ...(batch.spans === undefined
        ? {}
        : {
            spans: batch.spans.map((span) => ({
              ...span,
              ...sessions.correlate(span.attributes, span.resource),
            })),
          }),
      ...(batch.metrics === undefined
        ? {}
        : {
            metrics: batch.metrics.map((point) => ({
              ...point,
              ...sessions.correlate(point.attributes, point.resource),
            })),
          }),
      ...(batch.logs === undefined
        ? {}
        : {
            logs: batch.logs.map((record) => ({
              ...record,
              ...sessions.correlate(record.attributes, record.resource),
            })),
          }),
    };
    store.write(redactor.redact(correlated));
  }

  #send(
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    close = false,
  ): void {
    if (response.headersSent) return;
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...(close ? { connection: 'close' } : {}),
      ...(status === 405 ? { allow: 'POST' } : {}),
    });
    response.end(text);
  }
}
