// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { type PollFailure, PollLoop, type PollSource } from './poll-loop.js';

const INTERVAL = 60_000;
const BACKOFF_MAX = 600_000;

function source(
  id: string,
  poll: () => Promise<void> = () => Promise.resolve(),
): PollSource & {
  calls: number;
} {
  const self = {
    id,
    calls: 0,
    poll: async (): Promise<void> => {
      self.calls += 1;
      await poll();
    },
  };
  return self;
}

function loopOf(
  clock: FakeClock,
  sources: () => readonly PollSource[],
  failures: PollFailure[] = [],
  extra: { onFailure?: PollLoop['pass']; onListFailure?: (error: unknown) => void } = {},
): PollLoop {
  return new PollLoop({
    clock,
    interval: () => INTERVAL,
    backoffMax: () => BACKOFF_MAX,
    sources,
    onFailure: (failure) => {
      failures.push(failure);
    },
    ...(extra.onListFailure === undefined ? {} : { onListFailure: extra.onListFailure }),
  });
}

describe('PollLoop', () => {
  it('looks at every source in a pass, and at a source that is due only', async () => {
    const clock = new FakeClock();
    const a = source('a');
    const b = source('b');
    const loop = loopOf(clock, () => [a, b]);
    await loop.pass();
    await loop.pass();
    expect([a.calls, b.calls]).toEqual([2, 2]);
  });

  it('a failed source waits interval * 2^failures, up to the maximum, and the others go on', async () => {
    const clock = new FakeClock();
    const bad = source('bad', () => Promise.reject(new Error('down')));
    const good = source('good');
    const failures: PollFailure[] = [];
    const loop = loopOf(clock, () => [bad, good], failures);

    await loop.pass();
    expect(failures.map((f) => [f.failures, f.retryInMs])).toEqual([[1, 120_000]]);
    expect(good.calls).toBe(1);

    await clock.advance(119_999);
    await loop.pass();
    expect(bad.calls).toBe(1);
    expect(good.calls).toBe(2);

    await clock.advance(1);
    await loop.pass();
    expect(bad.calls).toBe(2);
    expect(failures.map((f) => [f.failures, f.retryInMs])).toEqual([
      [1, 120_000],
      [2, 240_000],
    ]);

    for (let n = 0; n < 4; n += 1) {
      await clock.advance(BACKOFF_MAX);
      await loop.pass();
    }
    expect(failures.at(-1)?.retryInMs).toBe(BACKOFF_MAX);
    expect(failures.at(-1)?.failures).toBe(6);
  });

  it('a look that works clears the failures of the source', async () => {
    const clock = new FakeClock();
    let broken = true;
    const flaky = source('flaky', () =>
      broken ? Promise.reject(new Error('down')) : Promise.resolve(),
    );
    const failures: PollFailure[] = [];
    const loop = loopOf(clock, () => [flaky], failures);
    await loop.pass();
    broken = false;
    await clock.advance(BACKOFF_MAX);
    await loop.pass();
    broken = true;
    await loop.pass();
    expect(failures.map((f) => f.failures)).toEqual([1, 1]);
  });

  it('forgets the schedule of a source that is no longer listed', async () => {
    const clock = new FakeClock();
    const bad = source('bad', () => Promise.reject(new Error('down')));
    let listed: readonly PollSource[] = [bad];
    const loop = loopOf(clock, () => listed);
    await loop.pass();
    listed = [];
    await loop.pass();
    listed = [bad];
    await loop.pass();
    expect(bad.calls).toBe(2);
  });

  it('tells a failure to make the list and goes on at the next pass', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    let broken = true;
    const ok = source('ok');
    const loop = loopOf(
      clock,
      () => {
        if (broken) throw new Error('no list');
        return [ok];
      },
      [],
      { onListFailure: (error) => errors.push(error) },
    );
    await loop.pass();
    expect(errors).toHaveLength(1);
    broken = false;
    await loop.pass();
    expect(ok.calls).toBe(1);
  });

  it('a handler that throws does not stop the loop', async () => {
    const clock = new FakeClock();
    const bad = source('bad', () => Promise.reject(new Error('down')));
    const good = source('good');
    const loop = new PollLoop({
      clock,
      interval: () => INTERVAL,
      backoffMax: () => BACKOFF_MAX,
      sources: () => [bad, good],
      onFailure: () => {
        throw new Error('handler bug');
      },
    });
    await expect(loop.pass()).resolves.toBeUndefined();
    expect(good.calls).toBe(1);
  });

  it('start looks now, then once per interval; stop leaves no timer and starting twice is one loop', async () => {
    const clock = new FakeClock();
    const a = source('a');
    const loop = loopOf(clock, () => [a]);
    loop.start();
    loop.start();
    await vi.waitFor(() => {
      expect(a.calls).toBe(1);
    });
    expect(loop.started).toBe(true);

    await clock.advance(INTERVAL - 1);
    expect(a.calls).toBe(1);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(a.calls).toBe(2);
    });

    await loop.stop();
    expect(loop.started).toBe(false);
    expect(clock.pendingSleeps).toBe(0);
    await clock.advance(INTERVAL * 3);
    expect(a.calls).toBe(2);
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});
