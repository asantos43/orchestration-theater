// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode, type Clock } from '@otheater/core';
import type { BackupTrigger } from '@otheater/protocol';
import { parseTimeOfDay, type BackupSettings } from '../config.js';
import type { Logger } from '../logger.js';
import type { BackupOutcome } from './backup.js';

/**
 * [proposta] How long to wait before trying again after a scheduled backup failed (disk full,
 * store busy). Never longer than the wait for the next due moment.
 */
export const RETRY_DELAY_MS = 900_000;

/** Never sleep less than this, so a clock that stands still cannot make the loop spin. */
const MIN_SLEEP_MS = 1000;

/**
 * Last and next moments, in the machine's local time, at which `after` (`HH:MM`) happens: `last` is
 * the latest one at or before `now`, `next` the first one after it. Built from calendar fields,
 * so a day that is 23 or 25 hours long (DST) still lands on the wall-clock time.
 */
export function dueMoments(now: number, after: string): { last: number; next: number } {
  const time = parseTimeOfDay(after);
  if (time === undefined) throw new RangeError(`not a time of day: ${after}`);
  const date = new Date(now);
  const at = (dayOffset: number): number =>
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + dayOffset,
      time.hour,
      time.minute,
      0,
      0,
    ).getTime();
  const today = at(0);
  return today <= now ? { last: today, next: at(1) } : { last: at(-1), next: today };
}

/**
 * What the daemon knows about the user being busy: epoch ms of the last activity (a request, a
 * running run). [proposta] The first version has no such source; `on_idle` then counts the time
 * since the scheduler started, so it makes one copy after the daemon has been up for `backup.idle`.
 */
export interface ActivityProbe {
  lastActivityAt(): number;
}

export interface BackupRunner {
  run(trigger: BackupTrigger): Promise<BackupOutcome>;
  latestBackupAt(): Promise<number | undefined>;
}

export interface BackupSchedulerOptions {
  readonly settings: Pick<BackupSettings, 'when' | 'after' | 'idle'>;
  readonly runner: BackupRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activity?: ActivityProbe | undefined;
  readonly retryDelayMs?: number | undefined;
}

/**
 * Starts backups by `backup.when` (architecture 5.21):
 * - `daily_after`: one copy a day after `backup.after`. If the daemon was off at that time, the
 *   copy is made as soon as it starts (catch-up): "no copy since the last due moment" is the test;
 * - `on_idle`: one copy once nothing happened for `backup.idle` and something happened since the
 *   last copy;
 * - `manual`: nothing runs by itself.
 * It waits with `Clock.sleep`, so the tests drive it with a `FakeClock`; `stop()` cancels the wait
 * and resolves after the backup in progress, if any, has finished.
 */
export class BackupScheduler {
  readonly #options: BackupSchedulerOptions;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(options: BackupSchedulerOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#loop !== undefined;
  }

  start(): void {
    if (this.#loop !== undefined || this.#options.settings.when === 'manual') return;
    this.#loop = this.#loopFor(this.#options.settings.when).catch((error: unknown) => {
      if (!hasErrorCode(error, 'CANCELLED')) {
        this.#options.logger.error({ err: error }, 'the backup scheduler stopped by itself');
      }
    });
  }

  async stop(): Promise<void> {
    this.#abort.abort(new Error('scheduler stopped'));
    await this.#loop;
  }

  #sleep(ms: number): Promise<void> {
    return this.#options.clock.sleep(Math.max(ms, MIN_SLEEP_MS), this.#abort.signal);
  }

  async #loopFor(when: 'daily_after' | 'on_idle'): Promise<void> {
    const startedAt = this.#options.clock.now();
    const { runner, clock, settings, logger } = this.#options;
    const retry = this.#options.retryDelayMs ?? RETRY_DELAY_MS;
    while (!this.#abort.signal.aborted) {
      const now = clock.now();
      if (when === 'daily_after') {
        const { last, next } = dueMoments(now, settings.after);
        const latest = await runner.latestBackupAt();
        if (latest === undefined || latest < last) {
          const outcome = await runner.run('schedule');
          if (!outcome.ok) {
            logger.warn({ retryInMs: Math.min(retry, next - now) }, 'scheduled backup failed');
            await this.#sleep(Math.min(retry, next - now));
            continue;
          }
        }
        await this.#sleep(next - clock.now());
      } else {
        const activityAt = this.#options.activity?.lastActivityAt() ?? startedAt;
        const quietFor = now - activityAt;
        if (quietFor < settings.idle) {
          await this.#sleep(settings.idle - quietFor);
          continue;
        }
        const latest = await runner.latestBackupAt();
        if (latest === undefined || latest < activityAt) {
          const outcome = await runner.run('schedule');
          if (!outcome.ok) {
            await this.#sleep(retry);
            continue;
          }
        }
        await this.#sleep(settings.idle);
      }
    }
  }
}
