// SPDX-License-Identifier: MPL-2.0
import { ApiClientError, ApiNetworkError, type ApiErrorContext } from './errors.js';

/**
 * What the two streaming clients of the package share (plan docs/17 P10): the observable state of
 * a connection (`connecting`, `open`, `retrying`, `closed`), the reconnection loop with its
 * exponential backoff, and an injectable clock so the tests never sleep. Browser-safe: no Node.
 */

export const CONNECTION_STATES = ['connecting', 'open', 'retrying', 'closed'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** What goes with a change of state. */
export interface ConnectionDetail {
  /** Failures in a row since the connection was last open; `0` while it is open. */
  readonly attempt: number;
  /** `retrying`: why the connection fell. `closed`: why it will not come back (none if `close()` was called). */
  readonly error?: ApiClientError | undefined;
  /** `retrying`: how long until the next try, in milliseconds. */
  readonly delayMs?: number | undefined;
}

export type ConnectionListener = (state: ConnectionState, detail: ConnectionDetail) => void;

/** Time as the loop needs it. Tests pass a clock that does not wait. */
export interface Clock {
  /** Resolves after `ms`, or as soon as `signal` fires (the caller checks the signal). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  },
};

/**
 * How a connection tries again. Every value has a default, and every one can be changed in the
 * options of the client. [proposta] The defaults are the plan's.
 */
export interface ReconnectOptions {
  /** Delay before the first retry, until the server says otherwise (`retry:`). Default 1000. */
  readonly initialDelayMs?: number | undefined;
  /** No delay grows past this, the server's `retry:` included. Default 30 000. */
  readonly maxDelayMs?: number | undefined;
  /** Multiplier of the delay at each failure in a row. Default 2. */
  readonly factor?: number | undefined;
  /** Random spread of each delay, as a fraction: `0.2` is plus or minus 20 %. `0` is none. Default 0.2. */
  readonly jitter?: number | undefined;
  /** Failures in a row after which the client gives up. Default `Infinity`. */
  readonly maxRetries?: number | undefined;
  /** A `Retry-After` of the daemon above this is cut to it. Default 300 000 (5 min). */
  readonly maxRetryAfterMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** A number in [0, 1) for the jitter. Default `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Closes the connection for good when it fires. */
  readonly signal?: AbortSignal | undefined;
}

export const DEFAULT_RECONNECT = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
  maxRetries: Number.POSITIVE_INFINITY,
  maxRetryAfterMs: 300_000,
} as const;

/** The delay before retry number `failures` (1 for the first). */
export function backoffDelayMs(
  failures: number,
  baseMs: number,
  options: { maxDelayMs: number; factor: number; jitter: number },
  random: () => number,
): number {
  const grown = Math.min(options.maxDelayMs, baseMs * options.factor ** Math.max(0, failures - 1));
  const spread = 1 + options.jitter * (2 * random() - 1);
  return Math.round(Math.min(options.maxDelayMs, Math.max(0, grown * spread)));
}

/**
 * Why one connection ended. A subclass throws it from `connectOnce`; `retryable` says whether
 * trying again can help (a network failure, a 503) or not (a 401, a message outside the contract).
 */
export class ConnectionFailure extends Error {
  override name = 'ConnectionFailure';
  readonly error: ApiClientError;
  readonly retryable: boolean;
  /** What the daemon asked for with `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(input: {
    readonly error: ApiClientError;
    readonly retryable: boolean;
    readonly retryAfterMs?: number | undefined;
  }) {
    super(input.error.message, { cause: input.error });
    this.error = input.error;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

/** A list of listeners that survives one of them throwing. */
export class Listeners<Args extends unknown[]> {
  readonly #set = new Set<(...args: Args) => void>();

  add(listener: (...args: Args) => void): () => void {
    this.#set.add(listener);
    return () => {
      this.#set.delete(listener);
    };
  }

  /**
   * Calls every listener. One that throws is ignored: a faulty screen must not take the stream
   * down with it, and the stream has no one else to tell.
   */
  emit(...args: Args): void {
    for (const listener of [...this.#set]) {
      try {
        listener(...args);
      } catch {
        // See above.
      }
    }
  }

  clear(): void {
    this.#set.clear();
  }
}

/** Where the connection is, for the errors it makes. */
export interface ConnectionIdentity extends ApiErrorContext {
  /** `scheme://host:port` of the daemon. */
  readonly origin: string;
}

/**
 * A connection that comes back by itself. The subclass says how to connect once; this class runs
 * the loop (state, backoff, `Retry-After`, give-up and close).
 */
export abstract class ReconnectingConnection {
  readonly #identity: ConnectionIdentity;
  readonly #options: {
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly factor: number;
    readonly jitter: number;
    readonly maxRetries: number;
    readonly maxRetryAfterMs: number;
  };
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #abort = new AbortController();
  readonly #listeners = new Listeners<[ConnectionState, ConnectionDetail]>();
  #state: ConnectionState = 'connecting';
  #detail: ConnectionDetail = { attempt: 0 };
  #serverRetryMs: number | undefined;
  #started = false;
  #settle: () => void = () => undefined;
  readonly #done: Promise<void>;

  protected constructor(identity: ConnectionIdentity, options: ReconnectOptions) {
    this.#identity = identity;
    this.#options = {
      initialDelayMs: options.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
      factor: options.factor ?? DEFAULT_RECONNECT.factor,
      jitter: options.jitter ?? DEFAULT_RECONNECT.jitter,
      maxRetries: options.maxRetries ?? DEFAULT_RECONNECT.maxRetries,
      maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_RECONNECT.maxRetryAfterMs,
    };
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#done = new Promise<void>((resolve) => {
      this.#settle = resolve;
    });
    const external = options.signal;
    if (external !== undefined) {
      if (external.aborted) {
        // Already closed: `onClosed` of the subclass is not called, it is not built yet.
        this.#abort.abort();
        this.#state = 'closed';
        this.#settle();
      } else {
        external.addEventListener(
          'abort',
          () => {
            this.close();
          },
          { once: true },
        );
      }
    }
  }

  /** The state now. Before `start()` it is `connecting`. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** What went with the last change of state. */
  get detail(): ConnectionDetail {
    return this.#detail;
  }

  /** Resolves, and never rejects, once the connection is `closed`; `detail.error` says why. */
  get done(): Promise<void> {
    return this.#done;
  }

  /** Watches the state. Returns the function that stops watching. */
  onState(listener: ConnectionListener): () => void {
    return this.#listeners.add(listener);
  }

  /** Starts connecting. Calling it again, or after `close()`, does nothing. */
  start(): this {
    if (this.#started || this.#state === 'closed') return this;
    this.#started = true;
    void this.#run();
    return this;
  }

  /** Closes for good: the connection in flight is dropped and nothing is tried again. */
  close(): void {
    this.#finish({ attempt: this.#detail.attempt });
  }

  /** Connects once and returns when that connection ends. Throws {@link ConnectionFailure} to say why. */
  protected abstract connectOnce(signal: AbortSignal, opened: () => void): Promise<void>;

  /** Called once the connection is closed for good, so the subclass drops its listeners. */
  protected onClosed(): void {
    // Nothing by default.
  }

  /** The reconnection time the server asked for (`retry:`); it replaces the initial delay. */
  protected setServerRetry(ms: number): void {
    // 0 would make every delay 0, whatever the growth.
    this.#serverRetryMs = Math.max(1, ms);
  }

  /** `true` once `close()` or the abort signal fired. */
  protected get stopped(): boolean {
    return this.#abort.signal.aborted;
  }

  #set(state: ConnectionState, detail: ConnectionDetail): void {
    if (this.#state === 'closed') return;
    this.#state = state;
    this.#detail = detail;
    this.#listeners.emit(state, detail);
  }

  #finish(detail: ConnectionDetail): void {
    if (this.#state === 'closed') return;
    this.#abort.abort();
    this.#set('closed', detail);
    this.#listeners.clear();
    this.onClosed();
    if (!this.#started) this.#settle();
  }

  async #run(): Promise<void> {
    const signal = this.#abort.signal;
    let failures = 0;
    while (!signal.aborted) {
      this.#set('connecting', { attempt: failures });
      let failure: ConnectionFailure;
      try {
        await this.connectOnce(signal, () => {
          failures = 0;
          this.#set('open', { attempt: 0 });
        });
        failure = new ConnectionFailure({
          error: new ApiNetworkError(
            { reason: 'connection', origin: this.#identity.origin, detail: 'closed by the daemon' },
            this.#identity,
          ),
          retryable: true,
        });
      } catch (thrown) {
        failure = failureOf(thrown, this.#identity);
      }
      if (this.stopped) break;
      failures += 1;
      if (!failure.retryable || failures > this.#options.maxRetries) {
        this.#finish({ attempt: failures, error: failure.error });
        break;
      }
      const delayMs = this.#delay(failures, failure.retryAfterMs);
      this.#set('retrying', { attempt: failures, error: failure.error, delayMs });
      await this.#clock.sleep(delayMs, signal);
    }
    this.#finish({ attempt: this.#detail.attempt });
    this.#settle();
  }

  #delay(failures: number, retryAfterMs: number | undefined): number {
    const { maxDelayMs, maxRetryAfterMs } = this.#options;
    const base = Math.min(maxDelayMs, this.#serverRetryMs ?? this.#options.initialDelayMs);
    const backoff = backoffDelayMs(failures, base, this.#options, this.#random);
    if (retryAfterMs === undefined) return backoff;
    return Math.max(backoff, Math.min(retryAfterMs, maxRetryAfterMs));
  }
}

/** Anything a subclass throws, as a failure: a bug of the client never escapes as a loose exception. */
function failureOf(thrown: unknown, identity: ConnectionIdentity): ConnectionFailure {
  if (thrown instanceof ConnectionFailure) return thrown;
  return new ConnectionFailure({
    error: new ApiClientError(
      `${identity.routeId ?? 'stream'}: unexpected failure: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      identity,
      { cause: thrown },
    ),
    retryable: false,
  });
}
