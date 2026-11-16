// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import type { BackupTrigger } from '@otheater/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger.js';
import type { BackupOutcome } from './backup.js';
import { BackupScheduler, dueMoments, type BackupRunner } from './schedule.js';

// Local wall-clock times, so the tests pass in any time zone.
const local = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('dueMoments', () => {
  it('before the time today: last is yesterday, next is today', () => {
    expect(dueMoments(local(16, 2, 30), '03:00')).toEqual({
      last: local(15, 3),
      next: local(16, 3),
    });
  });

  it('after the time today: last is today, next is tomorrow', () => {
    expect(dueMoments(local(16, 4), '03:00')).toEqual({ last: local(16, 3), next: local(17, 3) });
  });

  it('exactly at the time counts as passed', () => {
    expect(dueMoments(local(16, 3), '03:00')).toEqual({ last: local(16, 3), next: local(17, 3) });
  });

  it('crosses month and year ends', () => {
    expect(dueMoments(new Date(2026, 11, 31, 23, 0).getTime(), '03:00').next).toBe(
      new Date(2027, 0, 1, 3, 0).getTime(),
    );
  });

  it('rejects text that is not a time of day', () => {
    expect(() => dueMoments(0, '3pm')).toThrow(RangeError);
  });
});

/** A runner that records calls and answers from a small fake "disk". */
function fakeRunner(
  clock: FakeClock,
  options: { latest?: number; failures?: number } = {},
): BackupRunner & { runs: BackupTrigger[]; latest: number | undefined } {
  let failures = options.failures ?? 0;
  const runner = {
    runs: [] as BackupTrigger[],
    latest: options.latest,
    run(trigger: BackupTrigger): Promise<BackupOutcome> {
      runner.runs.push(trigger);
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve({
          ok: false,
          error: { code: 'TRANSIENT', message: 'disk full' },
          cause: new Error('disk full'),
        });
      }
      runner.latest = clock.now();
      return Promise.resolve({ ok: true, removed: [] } as unknown as BackupOutcome);
    },
    latestBackupAt: () => Promise.resolve(runner.latest),
  };
  return runner;
}

const settings = { when: 'daily_after', after: '03:00', idle: 30 * MINUTE } as const;

async function settle(): Promise<void> {
  // The scheduler awaits promises that resolve at once; a few turns let it reach its next sleep.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('BackupScheduler, daily_after', () => {
  it('waits for the time, runs once, then waits for the next day', async () => {
    const clock = new FakeClock(local(16, 1));
    const runner = fakeRunner(clock, { latest: local(15, 3, 5) });
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    expect(runner.runs).toEqual([]);

    await clock.advance(2 * HOUR + MINUTE); // 03:01
    await settle();
    expect(runner.runs).toEqual(['schedule']);

    await clock.advance(23 * HOUR); // next day 02:01: not yet
    await settle();
    expect(runner.runs).toHaveLength(1);
    await clock.advance(HOUR); // 03:01 next day
    await settle();
    expect(runner.runs).toHaveLength(2);
    await scheduler.stop();
  });

  it('catches up at start when the machine was off at the due time', async () => {
    const clock = new FakeClock(local(16, 9)); // after 03:00; last copy is from two days ago
    const runner = fakeRunner(clock, { latest: local(14, 3, 1) });
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    expect(runner.runs).toEqual(['schedule']);
    await scheduler.stop();
  });

  it('does not repeat when a copy already exists since the last due moment', async () => {
    const clock = new FakeClock(local(16, 9));
    const runner = fakeRunner(clock, { latest: local(16, 3, 2) });
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    expect(runner.runs).toEqual([]);
    await scheduler.stop();
  });

  it('makes the first copy right away when there is none', async () => {
    const clock = new FakeClock(local(16, 9));
    const runner = fakeRunner(clock);
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    expect(runner.runs).toEqual(['schedule']);
    await scheduler.stop();
  });

  it('retries after the retry delay when a copy fails, not before', async () => {
    const clock = new FakeClock(local(16, 9));
    const runner = fakeRunner(clock, { failures: 1 });
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
      retryDelayMs: 10 * MINUTE,
    });
    scheduler.start();
    await settle();
    expect(runner.runs).toHaveLength(1);
    await clock.advance(9 * MINUTE);
    await settle();
    expect(runner.runs).toHaveLength(1);
    await clock.advance(MINUTE);
    await settle();
    expect(runner.runs).toHaveLength(2);
    await scheduler.stop();
  });

  it('stop() cancels the wait, waits for nothing else and is safe twice', async () => {
    const clock = new FakeClock(local(16, 1));
    const runner = fakeRunner(clock, { latest: local(15, 3, 5) });
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    await scheduler.stop();
    await scheduler.stop();
    await clock.advance(48 * HOUR);
    await settle();
    expect(runner.runs).toEqual([]);
  });

  it('stop() waits for a copy in progress', async () => {
    const clock = new FakeClock(local(16, 9));
    let finish: () => void = () => undefined;
    const runner: BackupRunner = {
      latestBackupAt: () => Promise.resolve(undefined),
      run: () =>
        new Promise<BackupOutcome>((resolve) => {
          finish = () => {
            resolve({ ok: true, removed: [] } as unknown as BackupOutcome);
          };
        }),
    };
    const scheduler = new BackupScheduler({
      settings,
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await settle();
    const stopped = vi.fn();
    const stopping = scheduler.stop().then(stopped);
    await settle();
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(stopped).toHaveBeenCalled();
  });
});

describe('BackupScheduler, other modes', () => {
  it('manual never starts anything', async () => {
    const clock = new FakeClock(local(16, 9));
    const runner = fakeRunner(clock);
    const scheduler = new BackupScheduler({
      settings: { ...settings, when: 'manual' },
      runner,
      clock,
      logger: createSilentLogger(),
    });
    scheduler.start();
    await clock.advance(72 * HOUR);
    await settle();
    expect(scheduler.running).toBe(false);
    expect(runner.runs).toEqual([]);
  });

  it('on_idle copies once after the idle time, and again only after new activity', async () => {
    const clock = new FakeClock(local(16, 9));
    const runner = fakeRunner(clock);
    let activity = clock.now();
    const scheduler = new BackupScheduler({
      settings: { ...settings, when: 'on_idle' },
      runner,
      clock,
      logger: createSilentLogger(),
      activity: { lastActivityAt: () => activity },
    });
    scheduler.start();
    await settle();
    await clock.advance(29 * MINUTE);
    await settle();
    expect(runner.runs).toEqual([]);
    await clock.advance(MINUTE);
    await settle();
    expect(runner.runs).toEqual(['schedule']);

    // Nothing new happened: another idle period passes without a copy.
    await clock.advance(2 * HOUR);
    await settle();
    expect(runner.runs).toHaveLength(1);

    // Something happened, then quiet again.
    activity = clock.now();
    await clock.advance(31 * MINUTE);
    await settle();
    await clock.advance(30 * MINUTE);
    await settle();
    expect(runner.runs).toHaveLength(2);
    await scheduler.stop();
  });
});
