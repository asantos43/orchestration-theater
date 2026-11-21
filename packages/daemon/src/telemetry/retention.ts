// SPDX-License-Identifier: MPL-2.0
import { Cancelled, type Clock, type TelemetryStore } from '@otheater/core';
import type { TelemetryPurgedPayload } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';
import type { TelemetryRetentionSettings } from './retention-config.js';

const MS_PER_DAY = 86_400_000;
const NS_PER_MS = 1_000_000n;
const MB = 1024 * 1024;
/** The cap of the size loop deletes this much of the oldest data at a time (finer than a day). */
const SIZE_SLICE_MS = 3_600_000;
/** The most slices one pass takes; what is left waits for the next pass. */
const MAX_SLICES = 10_000;

/** The last day the daily aggregates cover and the first instant after it (epoch ms). */
export interface RetentionReady {
  readonly day: string;
  readonly untilMs: number;
}

export interface TelemetryRetentionDeps {
  readonly clock: Clock;
  readonly telemetry: TelemetryStore;
  /** Read at each pass; the `telemetry.retention` block is cold, so it does not change while the daemon runs. */
  readonly settings: () => TelemetryRetentionSettings;
  /** What the analysis has stored (P9). Used when the guard is `rollups`. */
  readonly ready: () => Promise<RetentionReady | null>;
  /** Runs before each pass, so the aggregates are as fresh as the analysis lets them be (its catch-up). */
  readonly prepare?: (() => Promise<unknown>) | undefined;
  readonly situations?: SituationSink | undefined;
  readonly logger: Pick<Logger, 'warn' | 'info'>;
}

/** What one pass did. */
export interface PurgeResult {
  readonly rows: number;
  readonly spans: number;
  readonly metrics: number;
  readonly logs: number;
  /** Bytes of data freed (pages in use before minus after), not the shrink of the file. */
  readonly bytes: number;
  /** The file was rewritten to give the disk back. */
  readonly compacted: boolean;
  /** Something was past a limit and the guard kept it, see `telemetry_purge_blocked`. */
  readonly blocked: boolean;
}

/**
 * The retention of the raw telemetry (Phase 8, P8; architecture 5.11, N216 (a)). [proposta]
 * One pass ({@link runOnce}):
 * 1. waits for `prepare` (the catch-up of the analysis), so the aggregates cover the days that
 *    are closed;
 * 2. removes what is older than `telemetry.retention.days`;
 * 3. while the data in use is over `telemetry.retention.max_mb`, removes the oldest hour;
 * 4. rewrites the file (`compact`) only when it is still over the cap, so the disk is given back.
 * With the guard `rollups` nothing at or after the end of the last ready day is removed, so no
 * raw telemetry is lost before it is summed up; with no ready day nothing is removed at all
 * (`analysis.schedule.mode: off`), and a base over a limit is told as a `telemetry_purge_blocked`
 * notice. The event log and `usage` (the store) and the daily aggregates are never touched.
 * The schedule ({@link start}) follows `telemetry.retention.mode`, on the clock handed in.
 */
export class TelemetryRetention {
  readonly #deps: TelemetryRetentionDeps;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;
  /** One pass at a time. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: TelemetryRetentionDeps) {
    this.#deps = deps;
  }

  /** Starts the schedule; a second call does nothing. With `telemetry.retention.mode: off` nothing runs. */
  start(): void {
    if (this.#loop !== undefined) return;
    if (this.#deps.settings().mode === 'off') return;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
    await this.#tail.catch(() => undefined);
  }

  async #run(): Promise<void> {
    try {
      await this.runOnce();
      while (this.#deps.settings().mode === 'daily') {
        await this.#deps.clock.sleep(this.#deps.settings().interval, this.#abort.signal);
        await this.runOnce();
      }
    } catch (error) {
      if (!this.#abort.signal.aborted && !(error instanceof Cancelled)) {
        this.#deps.logger.warn({ err: error }, 'the schedule of the telemetry retention stopped');
      }
    }
  }

  /**
   * One pass now (serialised with the others). It never rejects: a failure is logged and told as
   * a `telemetry_purge_failed` notice, and the next pass tries again.
   */
  runOnce(): Promise<PurgeResult | null> {
    const run = this.#tail.then(
      () => this.#pass(),
      () => this.#pass(),
    );
    this.#tail = run;
    return run;
  }

  async #pass(): Promise<PurgeResult | null> {
    const settings = this.#deps.settings();
    if (settings.days === 0 && settings.max_mb === 0) return null;
    let stage: 'purge' | 'compact' = 'purge';
    try {
      if (this.#deps.prepare !== undefined) {
        await this.#deps.prepare().catch((error: unknown) => {
          // The analysis tells its own failure; the pass goes on with the aggregates it has.
          this.#deps.logger.warn({ err: error }, 'the catch-up before the purge failed');
        });
      }
      return await this.#purge(settings, () => {
        stage = 'compact';
      });
    } catch (error) {
      this.#deps.logger.warn({ err: error, stage }, 'the telemetry purge failed');
      this.#deps.situations?.record('daemon.notice', {
        kind: 'telemetry_purge_failed',
        subject: situationSubject(stage),
        detail: situationText(error),
      });
      return null;
    }
  }

  async #purge(settings: TelemetryRetentionSettings, onCompact: () => void): Promise<PurgeResult> {
    const { telemetry, clock } = this.#deps;
    const now = clock.now();
    const ready = settings.guard === 'rollups' ? await this.#deps.ready() : null;
    // Nothing at or after this instant is removed (0: nothing at all; the guard waits for the aggregates).
    const ceiling = settings.guard === 'rollups' ? (ready?.untilMs ?? 0) : Number.POSITIVE_INFINITY;
    const limit = settings.max_mb * MB;

    const before = await telemetry.footprint();
    const oldestMs = (nanos: bigint | null): number | null =>
      nanos === null ? null : Number(nanos / NS_PER_MS);
    const first = oldestMs(before.oldestUnixNano);
    const totals = { spans: 0, metrics: 0, logs: 0 };
    let age = false;
    let size = false;
    let until = 0;
    const remove = async (cutMs: number): Promise<number> => {
      const done = await telemetry.deleteOlderThan(BigInt(cutMs) * NS_PER_MS);
      totals.spans += done.spans;
      totals.metrics += done.metrics;
      totals.logs += done.logs;
      until = Math.max(until, cutMs);
      return done.spans + done.metrics + done.logs;
    };

    // The age: everything older than `days`, up to the ceiling.
    const deadline = settings.days > 0 ? now - settings.days * MS_PER_DAY : 0;
    if (deadline > 0 && first !== null && first < Math.min(deadline, ceiling)) {
      age = (await remove(Math.min(deadline, ceiling))) > 0;
    }

    // The size: the oldest hour first, until the data in use fits or the ceiling is reached.
    let current = await telemetry.footprint();
    if (limit > 0) {
      for (let slice = 0; slice < MAX_SLICES && current.usedBytes > limit; slice += 1) {
        const oldest = oldestMs(current.oldestUnixNano);
        if (oldest === null || oldest >= ceiling) break;
        const removed = await remove(Math.min(ceiling, oldest + SIZE_SLICE_MS));
        if (removed > 0) size = true;
        current = await telemetry.footprint();
      }
    }

    // The disk: the file is rewritten only when it is still over the cap.
    let compacted = false;
    if (limit > 0 && current.fileBytes !== null && current.fileBytes > limit) {
      onCompact();
      await telemetry.compact();
      compacted = true;
      current = await telemetry.footprint();
    }

    const rows = totals.spans + totals.metrics + totals.logs;
    const bytes = Math.max(0, before.usedBytes - current.usedBytes);
    const result: PurgeResult = {
      rows,
      ...totals,
      bytes,
      compacted,
      blocked: this.#blocked(settings, current, now, ceiling, ready),
    };
    if (rows > 0) {
      const payload: TelemetryPurgedPayload = {
        reason: age && size ? 'age_and_size' : age ? 'age' : 'size',
        rows,
        ...totals,
        bytes,
        fileBytes: current.fileBytes,
        compacted,
        fromMs: first,
        untilMs: until,
        readyThrough: ready?.day ?? null,
      };
      this.#deps.logger.info(payload, 'the raw telemetry past the limits was purged');
      this.#deps.situations?.record('telemetry.purged', payload);
    }
    return result;
  }

  /** Told as a notice when a limit is passed and the guard keeps the oldest data from going. */
  #blocked(
    settings: TelemetryRetentionSettings,
    current: { readonly usedBytes: number; readonly oldestUnixNano: bigint | null },
    now: number,
    ceiling: number,
    ready: RetentionReady | null,
  ): boolean {
    if (settings.guard !== 'rollups' || current.oldestUnixNano === null) return false;
    const oldest = Number(current.oldestUnixNano / NS_PER_MS);
    if (oldest < ceiling) return false;
    const pastAge = settings.days > 0 && oldest < now - settings.days * MS_PER_DAY;
    const limit = settings.max_mb * MB;
    const pastSize = limit > 0 && current.usedBytes > limit;
    if (!pastAge && !pastSize) return false;
    const reason = pastSize
      ? `the base holds ${String(Math.round(current.usedBytes / MB))} MB, over the ${String(settings.max_mb)} MB cap`
      : `the oldest raw telemetry is older than ${String(settings.days)} days`;
    this.#deps.logger.warn(
      { usedBytes: current.usedBytes, readyThrough: ready?.day ?? null },
      'the telemetry purge waits for the daily aggregates',
    );
    this.#deps.situations?.record('daemon.notice', {
      kind: 'telemetry_purge_blocked',
      subject: pastSize ? 'size' : 'age',
      detail: situationText(
        `${reason}, and the daily aggregates cover ${
          ready === null ? 'no day yet' : `up to ${ready.day}`
        } (analysis.schedule.mode, or telemetry.retention.guard: none)`,
      ),
    });
    return true;
  }
}
