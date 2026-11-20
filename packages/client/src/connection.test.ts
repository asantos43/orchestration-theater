// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ConnectionFailure,
  DEFAULT_RECONNECT,
  Listeners,
  ReconnectingConnection,
  backoffDelayMs,
  systemClock,
  type ConnectionDetail,
  type ConnectionState,
  type ReconnectOptions,
} from './connection.js';
import { ApiClientError, ApiNetworkError } from './errors.js';
import { createTestClock } from './test-clock.test-support.js';

const identity = { origin: 'http://127.0.0.1:1', routeId: 'test' };
const down = (retryAfterMs?: number): ConnectionFailure =>
  new ConnectionFailure({
    error: new ApiNetworkError({ reason: 'connection', origin: identity.origin }, identity),
    retryable: true,
    retryAfterMs,
  });

/** What one `connectOnce` does: `open` then drop, or throw. */
type Step = (control: {
  opened: () => void;
  signal: AbortSignal;
  retry: (ms: number) => void;
}) => Promise<void>;

class Scripted extends ReconnectingConnection {
  readonly attempts: number[] = [];
  readonly #steps: Step[];
  #next = 0;

  constructor(steps: Step[], options: ReconnectOptions = {}) {
    super(identity, options);
    this.#steps = steps;
  }

  protected override async connectOnce(signal: AbortSignal, opened: () => void): Promise<void> {
    this.attempts.push(this.#next);
    const step = this.#steps[this.#next] ?? this.#steps[this.#steps.length - 1];
    this.#next += 1;
    await step?.({
      opened,
      signal,
      retry: (ms) => {
        this.setServerRetry(ms);
      },
    });
  }
}

const fail =
  (retryAfterMs?: number): Step =>
  () =>
    Promise.reject(down(retryAfterMs));

function record(
  connection: ReconnectingConnection,
): { state: ConnectionState; detail: ConnectionDetail }[] {
  const seen: { state: ConnectionState; detail: ConnectionDetail }[] = [];
  connection.onState((state, detail) => seen.push({ state, detail }));
  return seen;
}

describe('backoffDelayMs', () => {
  const options = { maxDelayMs: 30_000, factor: 2, jitter: 0 };

  it('doubles from the base and stops at the cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, 1000, options, () => 0.5));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('spreads by the jitter, below and above, and never past the cap', () => {
    const jittered = { maxDelayMs: 10_000, factor: 2, jitter: 0.2 };
    expect(backoffDelayMs(1, 1000, jittered, () => 0)).toBe(800);
    expect(backoffDelayMs(1, 1000, jittered, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(1, 1000, jittered, () => 0.999999)).toBe(1200);
    expect(backoffDelayMs(4, 5000, jittered, () => 0.999999)).toBe(10_000);
  });

  it('has the defaults of the plan', () => {
    expect(DEFAULT_RECONNECT).toMatchObject({
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      factor: 2,
    });
  });
});

describe('systemClock', () => {
  it('sleeps and wakes at once on abort', async () => {
    const abort = new AbortController();
    const started = Date.now();
    const sleeping = systemClock.sleep(60_000, abort.signal);
    abort.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
    await systemClock.sleep(1, new AbortController().signal);
    await systemClock.sleep(60_000, AbortSignal.abort());
  });
});

describe('Listeners', () => {
  it('survives a listener that throws and lets one leave', () => {
    const listeners = new Listeners<[number]>();
    const seen: number[] = [];
    listeners.add(() => {
      throw new Error('faulty screen');
    });
    const stop = listeners.add((n) => seen.push(n));
    listeners.emit(1);
    stop();
    listeners.emit(2);
    expect(seen).toEqual([1]);
  });
});

describe('the reconnection loop', () => {
  it('goes connecting, open, retrying, connecting, open and keeps the delays growing only while it fails', async () => {
    const clock = createTestClock();
    const connection = new Scripted(
      [
        fail(),
        fail(),
        // Opens, stays a moment, falls: the count starts over.
        ({ opened }) => {
          opened();
          return Promise.resolve();
        },
        fail(),
        ({ opened, signal }) => {
          opened();
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve();
            });
          });
        },
      ],
      { clock, random: () => 0.5 },
    );
    const seen = record(connection);
    connection.start();
    while (connection.attempts.length < 5) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connection.state).toBe('open');
    connection.close();
    await connection.done;

    // 1000 and 2000 for two failures; the open resets the count, and its own drop counts as the
    // first failure again (1000); the next failure in a row is the second (2000).
    expect(clock.sleeps).toEqual([1000, 2000, 1000, 2000]);
    expect(seen.map((entry) => entry.state)).toEqual([
      'connecting',
      'retrying',
      'connecting',
      'retrying',
      'connecting',
      'open',
      'retrying',
      'connecting',
      'retrying',
      'connecting',
      'open',
      'closed',
    ]);
    const retrying = seen.filter((entry) => entry.state === 'retrying');
    expect(retrying.map((entry) => [entry.detail.attempt, entry.detail.delayMs])).toEqual([
      [1, 1000],
      [2, 2000],
      [1, 1000],
      [2, 2000],
    ]);
    expect(retrying[0]?.detail.error).toBeInstanceOf(ApiNetworkError);
    expect(seen.at(-1)?.detail.error).toBeUndefined();
  });

  it('adjusts the base with the delay of the server, still under the cap', async () => {
    const clock = createTestClock();
    const connection = new Scripted(
      [
        ({ retry }) => {
          retry(4000);
          return Promise.reject(down());
        },
        fail(),
        fail(),
        fail(),
      ],
      { clock, random: () => 0.5, maxDelayMs: 20_000, maxRetries: 3 },
    );
    connection.start();
    await connection.done;
    expect(clock.sleeps).toEqual([4000, 8000, 16_000]);

    const capped = new Scripted(
      [
        ({ retry }) => {
          retry(90_000);
          return Promise.reject(down());
        },
        fail(),
      ],
      { clock: createTestClock(), random: () => 0.5, maxDelayMs: 20_000, maxRetries: 1 },
    );
    capped.start();
    await capped.done;
    expect(capped.detail.attempt).toBe(2);
  });

  it('treats a server delay of 0 as 1 ms, so the growth does not stay at 0', async () => {
    const clock = createTestClock();
    const connection = new Scripted(
      [
        ({ retry }) => {
          retry(0);
          return Promise.reject(down());
        },
        fail(),
        fail(),
      ],
      { clock, random: () => 0.5, maxRetries: 2 },
    );
    connection.start();
    await connection.done;
    expect(clock.sleeps).toEqual([1, 2]);
  });

  it('respects Retry-After as a floor, cuts it at the maximum, and keeps the backoff when it is longer', async () => {
    const clock = createTestClock();
    const connection = new Scripted([fail(7000), fail(999_999_000), fail(100)], {
      clock,
      random: () => 0.5,
      maxRetryAfterMs: 60_000,
      maxRetries: 3,
    });
    connection.start();
    await connection.done;
    // 7 s over the 1 s backoff; 60 s (the cut) over 2 s; the 4 s backoff over 0.1 s.
    expect(clock.sleeps).toEqual([7000, 60_000, 4000]);
  });

  it('gives up after maxRetries failures in a row, closed with the last error', async () => {
    const clock = createTestClock();
    const connection = new Scripted([fail()], { clock, maxRetries: 2 });
    const seen = record(connection);
    connection.start();
    await connection.done;
    expect(connection.attempts).toHaveLength(3);
    expect(clock.sleeps).toHaveLength(2);
    expect(connection.state).toBe('closed');
    expect(connection.detail.error).toBeInstanceOf(ApiNetworkError);
    expect(seen.at(-1)?.state).toBe('closed');
  });

  it('does not retry at all with maxRetries 0', async () => {
    const connection = new Scripted([fail()], { clock: createTestClock(), maxRetries: 0 });
    connection.start();
    await connection.done;
    expect(connection.attempts).toHaveLength(1);
    expect(connection.state).toBe('closed');
  });

  it('closes for good on a failure that is not retryable', async () => {
    const clock = createTestClock();
    const error = new ApiClientError('no way', identity);
    const connection = new Scripted(
      [() => Promise.reject(new ConnectionFailure({ error, retryable: false }))],
      { clock },
    );
    connection.start();
    await connection.done;
    expect(connection.state).toBe('closed');
    expect(connection.detail.error).toBe(error);
    expect(clock.sleeps).toEqual([]);
  });

  it('turns an exception that is not a failure into a closed connection with a typed error', async () => {
    const connection = new Scripted([() => Promise.reject(new TypeError('a bug'))], {
      clock: createTestClock(),
    });
    connection.start();
    await connection.done;
    expect(connection.state).toBe('closed');
    expect(connection.detail.error).toBeInstanceOf(ApiClientError);
    expect(connection.detail.error?.message).toContain('a bug');
  });

  it('closes while it waits to retry, at once, and never tries again', async () => {
    const connection = new Scripted([fail()], { initialDelayMs: 60_000, maxDelayMs: 60_000 });
    connection.start();
    while (connection.state !== 'retrying') await new Promise((resolve) => setTimeout(resolve, 1));
    connection.close();
    expect(connection.state).toBe('closed');
    await connection.done;
    expect(connection.attempts).toHaveLength(1);
  });

  it('closes before start, and start then does nothing; the abort signal closes too', async () => {
    const early = new Scripted([fail()]);
    early.close();
    early.start();
    await early.done;
    expect(early.attempts).toEqual([]);
    expect(early.state).toBe('closed');

    const aborted = new Scripted([fail()], { signal: AbortSignal.abort() });
    expect(aborted.state).toBe('closed');
    await aborted.done;

    const abort = new AbortController();
    const live = new Scripted(
      [
        ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve();
            });
          }),
      ],
      {
        signal: abort.signal,
      },
    );
    live.start();
    abort.abort();
    await live.done;
    expect(live.state).toBe('closed');
  });

  it('starts once', async () => {
    const connection = new Scripted([
      ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve();
          });
        }),
    ]);
    connection.start().start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    connection.close();
    await connection.done;
    expect(connection.attempts).toHaveLength(1);
  });
});
