// SPDX-License-Identifier: MPL-2.0
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode, type Clock, type EventLog } from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import { failPoint } from '../chaos/crash-points.js';
import { freeBytesOf, sizeText } from './free-space.js';
import type { DiskSettings } from './settings.js';

/**
 * The full disk (Phase 11, P5; N279; docs/23). One place hears every write that found no room (the
 * store, the log, a backup) and the free space read from the file system, and decides what the
 * daemon does (`disk.on_full`), what it says (`disk.notify`) and when it is back.
 *
 * - `ok` to `full`: the first {@link DiskGuard.report} (a `DiskFull` of a write) or a read of the
 *   free space below `disk.min_free`. The area (`store`, `log`, `backup`, `data`...) is kept for the
 *   notice. `pause` closes the gate of new plays; `stop` also closes it and asks the daemon to stop;
 *   `continue` leaves everything as it was.
 * - `full` to `ok`: a pass of the check finds every area above `disk.min_free` and the store takes a
 *   write again ({@link DiskGuardOptions.probe}). The gate opens, `disk_recovered` is told, and the
 *   plays a `DiskFull` hit ({@link DiskGuard.hit}) are resumed: their state was never changed by the
 *   write that failed (a transaction is whole or it is nothing), so `resume` asks for the effects
 *   of the state they are in once more.
 *
 * Rules [proposta]:
 * - the situation is a log line first and an event second; an event the full store cannot take
 *   waits and is written, with the time it happened, as soon as a write goes through;
 * - the guard never throws into the code that reported to it, and never waits for it;
 * - the loop uses real timers, not the clock of the daemon: a fake clock must not freeze the check
 *   that brings the daemon back. The clock stamps the notices and measures `every_hour`.
 */

/**
 * Whether an error is a full disk: the typed `DiskFull` of the store, or the raw `ENOSPC` of a
 * write to a file (the log, a backup), which is not an `OTheaterError`.
 */
export function isDiskFull(error: unknown): boolean {
  if (hasErrorCode(error, 'DISK_FULL')) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ENOSPC' || errno === -28;
}

/** The file {@link probeFolder} writes and removes. */
const PROBE_FILE = '.otheater-disk-probe';

/**
 * A write the way the daemon writes to the area: one small file in its folder, then removed. It is
 * what tells that a log or a backup folder takes a write again when `statfs` says there is room
 * (`disk.min_free: off`, or a quota that `statfs` does not show). A folder that is not there is not a
 * full disk.
 */
export async function probeFolder(area: DiskArea): Promise<void> {
  const file = join(area.path, PROBE_FILE);
  try {
    failPoint('fs.write', area.name);
    await writeFile(file, 'probe\n');
    await unlink(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return;
    throw error;
  }
}

/** A place the daemon writes to and the guard watches the free space of. */
export interface DiskArea {
  readonly name: string;
  readonly path: string;
}

export type DiskNoticeKind = 'disk_full' | 'disk_recovered';

export interface DiskGuardLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DiskGuardOptions {
  readonly clock: Pick<Clock, 'now'>;
  /** Read at each use (a test changes it at once); `disk.*` is not a hot section of the config, so a real edit waits for a restart. */
  readonly settings: () => DiskSettings;
  readonly areas: () => readonly DiskArea[];
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: DiskGuardLogger;
  /** Resolves when the store takes a write; rejects with `DiskFull` while it does not. Default: none. */
  readonly probe?: (() => Promise<void>) | undefined;
  /** Resumes one play (the runner's `resume`). */
  readonly resume?: ((playId: string) => Promise<void>) | undefined;
  /** `disk.on_full: stop`: asks the daemon to stop. */
  readonly stop?: (() => void) | undefined;
  /**
   * Resolves when a small file can be written in the folder of an area (not the store, which has
   * {@link DiskGuardOptions.probe}); rejects with the error of the write (`ENOSPC`). A folder that
   * does not exist is not a problem. Default: {@link probeFolder}.
   */
  readonly probeArea?: ((area: DiskArea) => Promise<void>) | undefined;
  /** Test seam: the free bytes of a path. Default: `statfs`. */
  readonly freeBytes?: ((path: string) => Promise<number | undefined>) | undefined;
}

export type DiskState = 'ok' | 'full';

export interface DiskStatus {
  readonly state: DiskState;
  /** When the disk became full (epoch ms), while it is. */
  readonly since: number | null;
  readonly areas: readonly string[];
  /** The plays a full disk hit and that wait to be resumed. */
  readonly hitPlays: readonly string[];
}

const HOUR_MS = 60 * 60 * 1000;

export class DiskGuard {
  #o: DiskGuardOptions;
  #state: DiskState = 'ok';
  #since: number | null = null;
  readonly #areas = new Set<string>();
  readonly #hits = new Set<string>();
  #told: 'none' | 'told' = 'none';
  #lastToldAt = 0;
  /** The `disk_full` that the store could not take: written, with its time, before the next notice. */
  #pendingFull: { readonly at: number; readonly subject: string; readonly detail: string } | null =
    null;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #ticking: Promise<void> = Promise.resolve();
  #announcing: Promise<void> = Promise.resolve();

  constructor(options: DiskGuardOptions) {
    this.#o = { ...options };
  }

  /**
   * Hands over what exists only after the guard was made: the composition builds the guard before
   * the orchestration (whose runner resumes the plays) and before the handle (whose `stop` ends
   * the daemon).
   */
  bind(parts: {
    readonly resume?: ((playId: string) => Promise<void>) | undefined;
    readonly stop?: (() => void) | undefined;
  }): void {
    this.#o = { ...this.#o, ...parts };
  }

  /** The gate of new work: `true` while the daemon must not open plays or tasks. */
  paused(): boolean {
    return this.#state === 'full' && this.#o.settings().onFull !== 'continue';
  }

  status(): DiskStatus {
    return {
      state: this.#state,
      since: this.#since,
      areas: [...this.#areas],
      hitPlays: [...this.#hits],
    };
  }

  /** Starts the periodic check. It reads the free space once at once, so a start on a full disk is seen. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Ends the check and waits for the pass in progress and for the notices on their way. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#ticking;
    await this.#announcing;
  }

  /**
   * A write found no room (`area`: where). Anything that is not a `DiskFull` is ignored, so a caller
   * can hand over whatever it caught. Never throws.
   */
  report(area: string, error: unknown): void {
    if (!isDiskFull(error)) return;
    this.#enter(area, error instanceof Error ? error.message : 'no space left on the device');
  }

  /** A play that a `DiskFull` hit: it is resumed when the space returns. */
  hit(playId: string): void {
    this.#hits.add(playId);
  }

  /** One pass of the check now (the loop calls it; a test calls it to not wait). */
  tick(): Promise<void> {
    const run = this.#ticking.then(() => this.#tick());
    this.#ticking = run.catch(() => undefined);
    return run;
  }

  /** Resolves when the notices on their way were written or failed. For tests and shutdown. */
  idle(): Promise<void> {
    return this.#announcing;
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => {
        this.#schedule(this.#o.settings().checkEveryMs);
      });
    }, ms);
    this.#timer.unref();
  }

  /** The areas whose free space is below `disk.min_free`, with the bytes left. */
  async #low(): Promise<{ area: DiskArea; free: number }[]> {
    const { minFreeBytes } = this.#o.settings();
    if (minFreeBytes === null) return [];
    const read = this.#o.freeBytes ?? freeBytesOf;
    const low: { area: DiskArea; free: number }[] = [];
    const seen = new Set<string>();
    for (const area of this.#o.areas()) {
      if (seen.has(area.path)) continue;
      seen.add(area.path);
      const free = await read(area.path);
      if (free !== undefined && free < minFreeBytes) low.push({ area, free });
    }
    return low;
  }

  async #tick(): Promise<void> {
    const settings = this.#o.settings();
    const low = await this.#low();
    const first = low[0];
    if (this.#state === 'ok') {
      if (first !== undefined) {
        this.#enter(
          first.area.name,
          `${sizeText(first.free)} free on ${first.area.path}, below disk.min_free (${sizeText(settings.minFreeBytes ?? 0)})`,
        );
      }
      return;
    }
    // Full: the space is back only when every area is above the floor and a write goes through.
    if (first === undefined) {
      try {
        await this.#o.probe?.();
        const probeArea = this.#o.probeArea ?? probeFolder;
        for (const area of this.#o.areas()) {
          if (this.#areas.has(area.name) && area.name !== 'store') await probeArea(area);
        }
        await this.#recover();
        return;
      } catch (error) {
        if (!isDiskFull(error)) {
          this.#o.logger.warn({ err: error }, 'the probe of the disk failed for another reason');
        }
      }
    }
    this.#maybeRepeat();
  }

  #enter(area: string, why: string): void {
    this.#areas.add(area);
    if (this.#state === 'full') return;
    this.#state = 'full';
    this.#since = this.#o.clock.now();
    const { onFull } = this.#o.settings();
    this.#o.logger.error({ area, why, onFull }, 'the disk is full');
    const detail = `${why}; disk.on_full: ${onFull}`.slice(0, 500);
    this.#announce('disk_full', area, detail, true);
    if (onFull === 'stop') {
      // After the notice was tried, so the Producer can read why the daemon ended.
      void this.#announcing.then(() => this.#o.stop?.());
    }
    // A write that reported late may find the loop stopped (a test that drives `tick` by hand).
  }

  async #recover(): Promise<void> {
    const areas = [...this.#areas];
    const hits = [...this.#hits];
    const since = this.#since;
    this.#state = 'ok';
    this.#since = null;
    this.#areas.clear();
    this.#hits.clear();
    this.#told = 'none';
    this.#o.logger.info({ areas, plays: hits }, 'the disk has room again');
    // Back to work first: the plays the full disk hit go on while the notice is written.
    this.#announce(
      'disk_recovered',
      areas.join(', ') || null,
      `the space is back after ${since === null ? '?' : `${String(Math.round((this.#o.clock.now() - since) / 1000))} s`}; ${String(hits.length)} play(s) resumed`,
      false,
    );
    for (const playId of hits) {
      try {
        await this.#o.resume?.(playId);
      } catch (error) {
        this.#o.logger.warn({ playId, err: error }, 'a play the full disk hit was not resumed');
      }
    }
  }

  /** `every_hour`: tells again once an hour has passed since the last time. */
  #maybeRepeat(): void {
    if (this.#o.settings().notify !== 'every_hour') return;
    if (this.#o.clock.now() - this.#lastToldAt < HOUR_MS) return;
    this.#announce(
      'disk_full',
      [...this.#areas].join(', '),
      `still full since ${String(this.#since)}; disk.on_full: ${this.#o.settings().onFull}`,
      true,
    );
  }

  /**
   * Writes the notice as `disk.notify` allows: `off` never; `once` at the start of an episode and
   * at its end; `every_hour` also again each hour. The event waits in order behind the ones before it.
   */
  #announce(kind: DiskNoticeKind, subject: string | null, detail: string, opening: boolean): void {
    const { notify } = this.#o.settings();
    if (notify === 'off') return;
    if (opening) {
      if (this.#told === 'told' && notify === 'once') return;
      this.#told = 'told';
      this.#lastToldAt = this.#o.clock.now();
    }
    const at = this.#o.clock.now();
    this.#announcing = this.#announcing.then(async () => {
      if (kind === 'disk_full') {
        try {
          await this.#append(kind, subject, detail);
          this.#pendingFull = null;
        } catch (error) {
          this.#pendingFull = { at, subject: subject ?? '', detail };
          this.#o.logger.warn(
            { err: error },
            'the notice of the full disk could not be written; it waits for room',
          );
        }
        return;
      }
      // `disk_recovered`: the store took the probe, so the notice that waited goes first.
      const waiting = this.#pendingFull;
      try {
        if (waiting !== null) {
          await this.#append(
            'disk_full',
            waiting.subject === '' ? null : waiting.subject,
            `${waiting.detail} (at ${new Date(waiting.at).toISOString()})`,
          );
          this.#pendingFull = null;
        }
        await this.#append(kind, subject, detail);
      } catch (error) {
        this.#o.logger.warn({ err: error }, 'the notice of the disk was not written');
      }
    });
  }

  async #append(kind: DiskNoticeKind, subject: string | null, detail: string): Promise<void> {
    await this.#o.events.append(
      buildDaemonEvent('daemon.notice', {
        kind,
        subject: subject === null || subject === '' ? null : subject.slice(0, 256),
        detail: detail.slice(0, 512),
      }),
    );
  }
}
