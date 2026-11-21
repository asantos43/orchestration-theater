// SPDX-License-Identifier: MPL-2.0
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Clock, SecretVault, TelemetryStore } from '@otheater/core';
import type { TelemetryExportFailureReason } from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { OTLP_PATH, encodeOtlp } from './otlp-encode.js';
import type { OtlpSignal } from './otlp.js';

/**
 * The OTLP exporter (Phase 8, P7; architecture 5.11, N70 and N211). [proposta] It reads the
 * telemetry base by row id, one cursor per signal, and POSTs what it read to the endpoint as OTLP/HTTP
 * JSON. It is never what the daemon depends on: it does not block, does not throw out of `start()`
 * and a destination that is down costs a warning and an event, not a play.
 *
 * How it stays right:
 * - the cursor of each signal lives in the telemetry base (`otlp-export:<signal>`) and is saved
 *   only after the destination took the batch (or the batch was dropped, see below). A base that was
 *   deleted has no cursor, and the export starts again at the first row it holds;
 * - delivery is at least once: a daemon that stops between the answer and the cursor sends that batch
 *   again. OTLP receivers are expected to take that (spans repeat by id);
 * - a request is retried `retry.retries` times with `retry.backoff` between tries, but only when the
 *   answer says a retry can help (no answer, a timeout, 429, 502, 503, 504; the OTLP spec, [S:
 *   opentelemetry.io/docs/specs/otlp, "OTLP/HTTP Response"]). A 401, 403 or any other 4xx is final;
 * - after the retries, `on_failure: drop` (default) moves the cursor past the batch and says so; `hold`
 *   keeps the cursor and tries the same batch at the next turn;
 * - the failures are told in `telemetry.export_failed` once per `failure_report` window and per
 *   signal and reason, with the count of what happened in the window, so a dead destination is not
 *   an event every few seconds;
 * - the headers come from the vault at the time of each batch, and the plain text is only in the
 *   request. It is in no log, event or error text.
 */

/** The name of the cursor of a signal. */
export function exportCursorName(signal: OtlpSignal): string {
  return `otlp-export:${signal}`;
}

const SIGNALS: readonly OtlpSignal[] = ['traces', 'metrics', 'logs'];
const SIGNAL_KEY = { traces: 'spans', metrics: 'metrics', logs: 'logs' } as const;

/** Statuses a retry may fix, from the OTLP/HTTP specification. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export type OtlpExporterConfig = DaemonConfig['telemetry']['otlp'];

export interface OtlpExporterOptions {
  readonly telemetry: TelemetryStore;
  readonly config: OtlpExporterConfig;
  readonly vault: SecretVault;
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly situations?: SituationSink | undefined;
  /** For tests: the `fetch` that sends the request. */
  readonly fetch?: typeof fetch | undefined;
}

/** What an exporter did since it started (the counters of `/metrics`). */
export interface OtlpExporterStats {
  /** Records the destination took. */
  readonly exported: number;
  /** Records dropped after the retries (`on_failure: drop`), by reason. */
  readonly dropped: Readonly<Partial<Record<TelemetryExportFailureReason, number>>>;
}

/** The scheme, host and port of the endpoint: what the event and the log may say of it. */
export function destinationOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * The URL of a signal: the path of the endpoint (a base, with or without a final slash) plus its
 * OTLP path. A query of the endpoint stays where it is, after the path.
 */
export function signalUrl(endpoint: string, signal: OtlpSignal): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${OTLP_PATH[signal]}`;
  return url.toString();
}

/** What went wrong with one request, for the retry and for the event. */
class SendFailure extends Error {
  constructor(
    readonly reason: TelemetryExportFailureReason,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(reason);
    this.name = 'SendFailure';
  }
}

interface FailureWindow {
  reportedAt: number | null;
  count: number;
  batches: number;
  status: number | null;
  mode: 'drop' | 'hold';
}

const gzipAsync = promisify(gzip);

export class OtlpExporter {
  readonly #telemetry: TelemetryStore;
  readonly #config: OtlpExporterConfig;
  readonly #vault: SecretVault;
  readonly #clock: Clock;
  readonly #logger: Pick<Logger, 'warn' | 'debug'>;
  readonly #situations: SituationSink | undefined;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #destination: string;
  readonly #stop = new AbortController();
  /** Aborted by {@link finish} and {@link stop}: no more retries, no more waiting for a backoff. */
  readonly #hurry = new AbortController();
  readonly #windows = new Map<string, FailureWindow>();
  /** The cursor a signal is held at, so a held batch is counted once in the event. */
  readonly #heldAt = new Map<OtlpSignal, number>();
  readonly #dropped: Partial<Record<TelemetryExportFailureReason, number>> = {};
  #exported = 0;
  #loop: Promise<void> | undefined;
  #running: Promise<void> = Promise.resolve();

  constructor(options: OtlpExporterOptions) {
    if (options.config.endpoint === null) {
      throw new TypeError('the OTLP exporter needs telemetry.otlp.endpoint');
    }
    this.#telemetry = options.telemetry;
    this.#config = options.config;
    this.#vault = options.vault;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#situations = options.situations;
    this.#fetch = options.fetch ?? fetch;
    this.#endpoint = options.config.endpoint;
    this.#destination = destinationOf(this.#endpoint);
  }

  get stats(): OtlpExporterStats {
    return { exported: this.#exported, dropped: { ...this.#dropped } };
  }

  /** Starts the loop. Idempotent. */
  start(): void {
    this.#loop ??= this.#run();
  }

  /**
   * Stops the loop and what it is waiting for or sending; the failures told in no event yet are told.
   * Idempotent, never rejects.
   */
  async stop(): Promise<void> {
    this.#stop.abort();
    this.#hurry.abort();
    await this.#loop?.catch(() => undefined);
    await this.#running.catch(() => undefined);
    this.#reportPending();
  }

  /**
   * The last pass, at shutdown: what the base has that was not sent yet goes once more, with no
   * retries and no waiting, and the first failure ends it. A batch that fails here is **not** dropped
   * (the cursor stays), so the next start sends it; this is why a destination that is down does not
   * delay the shutdown by more than one timeout. Call {@link stop} after it. Never rejects.
   */
  async finish(): Promise<void> {
    this.#hurry.abort();
    await this.exportOnce();
  }

  /**
   * One turn: every enabled signal is read from its cursor and sent, batch after batch, until the
   * base has no more or a batch fails. Turns do not overlap. Never rejects.
   */
  exportOnce(): Promise<void> {
    const turn = this.#running.then(() => this.#turn());
    this.#running = turn.catch(() => undefined);
    return this.#running;
  }

  async #run(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      await this.exportOnce();
      try {
        await this.#clock.sleep(this.#config.interval, this.#stop.signal);
      } catch {
        return;
      }
    }
  }

  async #turn(): Promise<void> {
    for (const signal of SIGNALS) {
      if (this.#stop.signal.aborted) return;
      if (this.#config.signals[signal] === 'off') continue;
      try {
        const done = await this.#drain(signal);
        if (!done && this.#hurry.signal.aborted) return;
      } catch (error) {
        // A bug here must not reach the daemon: it is told like any other failure.
        this.#logger.debug({ signal, err: String(error) }, 'the OTLP export turn failed');
      }
    }
  }

  /**
   * Sends the batches of one signal until the base has none left, or one fails. Resolves `false`
   * when it stopped on a failure it did not drop.
   */
  async #drain(signal: OtlpSignal): Promise<boolean> {
    const name = exportCursorName(signal);
    for (;;) {
      if (this.#stop.signal.aborted) return true;
      let cursor: number;
      let rows: readonly { readonly rowId: number; readonly record: unknown }[];
      try {
        cursor = (await this.#telemetry.readCursor(name)) ?? 0;
        rows = await this.#telemetry.readSince(SIGNAL_KEY[signal], cursor, this.#config.batch);
      } catch {
        this.#fail(signal, new SendFailure('store_unavailable', null, false), 1);
        return false;
      }
      const last = rows.at(-1);
      if (last === undefined) return true;
      const body = encodeOtlp(signal, rows.map((row) => row.record) as never);
      try {
        await this.#send(signal, body);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stop()` aborts while the request is in flight
        if (this.#stop.signal.aborted) return true;
        const failure =
          error instanceof SendFailure ? error : new SendFailure('unreachable', null, false);
        if (this.#hurry.signal.aborted) {
          // Shutting down: the batch stays in the base for the next start, whatever `on_failure` says.
          this.#fail(signal, failure, rows.length, 'hold');
          return false;
        }
        if (this.#config.on_failure === 'hold') {
          const counted = this.#heldAt.get(signal) !== cursor;
          this.#heldAt.set(signal, cursor);
          this.#fail(signal, failure, counted ? rows.length : 0);
          return false;
        }
        this.#dropped[failure.reason] = (this.#dropped[failure.reason] ?? 0) + rows.length;
        this.#fail(signal, failure, rows.length);
        await this.#save(name, last.rowId);
        continue;
      }
      this.#heldAt.delete(signal);
      this.#exported += rows.length;
      await this.#save(name, last.rowId);
      if (rows.length < this.#config.batch) return true;
    }
  }

  async #save(name: string, rowId: number): Promise<void> {
    try {
      await this.#telemetry.writeCursor(name, rowId);
    } catch (error) {
      this.#logger.debug({ err: String(error) }, 'the OTLP export cursor could not be saved');
    }
  }

  /** One batch, with the retries. Throws a {@link SendFailure}. */
  async #send(signal: OtlpSignal, body: Record<string, unknown>): Promise<void> {
    const retries = this.#hurry.signal.aborted ? 0 : this.#config.retry.retries;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#post(signal, body);
        return;
      } catch (error) {
        if (!(error instanceof SendFailure)) throw error;
        if (!error.retryable || attempt >= retries || this.#hurry.signal.aborted) throw error;
      }
      try {
        await this.#clock.sleep(this.#backoff(attempt), this.#hurry.signal);
      } catch {
        throw new SendFailure('unreachable', null, false);
      }
    }
  }

  #backoff(attempt: number): number {
    const { backoff, initial, max } = this.#config.retry;
    return backoff === 'fixed' ? initial : Math.min(initial * 2 ** attempt, max);
  }

  async #headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [name, key] of Object.entries(this.#config.headers)) {
      let secret;
      try {
        secret = await this.#vault.get(key);
      } catch {
        throw new SendFailure('secret_missing', null, false);
      }
      if (secret === undefined) throw new SendFailure('secret_missing', null, false);
      headers[name] = secret.reveal();
    }
    return headers;
  }

  async #post(signal: OtlpSignal, body: Record<string, unknown>): Promise<void> {
    const headers = await this.#headers();
    const json = JSON.stringify(body);
    let payload: string | Uint8Array = json;
    // Ours go last: a configured header cannot change what the body is.
    const sent: Record<string, string> = { ...headers, 'Content-Type': 'application/json' };
    if (this.#config.compression === 'gzip') {
      payload = await gzipAsync(json);
      sent['Content-Encoding'] = 'gzip';
    }
    const controller = new AbortController();
    const onStop = (): void => {
      controller.abort();
    };
    this.#stop.signal.addEventListener('abort', onStop, { once: true });
    let timedOut = false;
    const timer = this.#clock.sleep(this.#config.timeout, controller.signal).then(
      () => {
        timedOut = true;
        controller.abort();
      },
      () => undefined,
    );
    try {
      const response = await this.#fetch(signalUrl(this.#endpoint, signal), {
        method: 'POST',
        headers: sent,
        body: payload as BodyInit,
        signal: controller.signal,
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      throw failureOfStatus(response.status);
    } catch (error) {
      if (error instanceof SendFailure) throw error;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the timer sets `timedOut` while the request is in flight
      throw new SendFailure(timedOut ? 'timeout' : 'unreachable', null, true);
    } finally {
      this.#stop.signal.removeEventListener('abort', onStop);
      controller.abort();
      await timer;
    }
  }

  /** Counts a failure and tells it when the window of its signal and reason allows. */
  #fail(
    signal: OtlpSignal,
    failure: SendFailure,
    count: number,
    mode: FailureWindow['mode'] = this.#config.on_failure,
  ): void {
    const key = `${signal}:${failure.reason}`;
    const window = this.#windows.get(key) ?? {
      reportedAt: null,
      count: 0,
      batches: 0,
      status: null,
      mode,
    };
    window.count += count;
    window.batches += 1;
    window.status = failure.status;
    window.mode = mode;
    this.#windows.set(key, window);
    const now = this.#clock.now();
    if (window.reportedAt === null || now - window.reportedAt >= this.#config.failure_report) {
      this.#report(signal, failure.reason, window, now);
    } else {
      this.#logger.debug(
        { signal, reason: failure.reason },
        'the OTLP export failed again; told with the next report',
      );
    }
  }

  #report(
    signal: OtlpSignal,
    reason: TelemetryExportFailureReason,
    window: FailureWindow,
    now: number,
  ): void {
    window.reportedAt = now;
    // A held batch that was already counted adds no records: the event needs at least one.
    const count = Math.max(window.count, 1);
    const { batches, status, mode } = window;
    window.count = 0;
    window.batches = 0;
    this.#logger.warn(
      { destination: this.#destination, signal, reason, status, count, batches, mode },
      'the OTLP export did not reach its destination',
    );
    this.#situations?.record('telemetry.export_failed', {
      destination: this.#destination,
      signal,
      reason,
      status,
      count,
      batches,
      mode,
    });
  }

  /** What the windows still hold when the exporter stops. */
  #reportPending(): void {
    const now = this.#clock.now();
    for (const [key, window] of this.#windows) {
      if (window.batches === 0) continue;
      const [signal, reason] = key.split(':') as [OtlpSignal, TelemetryExportFailureReason];
      this.#report(signal, reason, window, now);
    }
  }
}

function failureOfStatus(status: number): SendFailure {
  const retryable = RETRYABLE_STATUS.has(status);
  if (status === 401 || status === 403) return new SendFailure('unauthorized', status, false);
  if (status >= 500) return new SendFailure('server_error', status, retryable);
  return new SendFailure('rejected', status, retryable);
}
