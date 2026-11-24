// SPDX-License-Identifier: MPL-2.0
import { DiskFull, type EventLog, type NewEvent } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskGuard, probeFolder, type DiskGuardOptions } from './guard.js';
import type { DiskSettings } from './settings.js';

const SETTINGS: DiskSettings = {
  onFull: 'pause',
  minFreeBytes: 1000,
  notify: 'once',
  checkEveryMs: 10,
};

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Rig {
  readonly guard: DiskGuard;
  readonly clock: FakeClock;
  readonly written: NewEvent[];
  readonly resumed: string[];
  readonly stops: number[];
  settings: DiskSettings;
  free: number;
  /** While true the store answers `DiskFull` to `append` and to the probe. */
  storeFull: boolean;
}

function rig(initial: Partial<DiskSettings> = {}): Rig {
  const clock = new FakeClock();
  const written: NewEvent[] = [];
  const resumed: string[] = [];
  const stops: number[] = [];
  const state: Rig = {
    clock,
    written,
    resumed,
    stops,
    settings: { ...SETTINGS, ...initial },
    free: 1_000_000,
    storeFull: false,
    guard: undefined as unknown as DiskGuard,
  };
  const events: Pick<EventLog, 'append'> = {
    append: (event) => {
      if (state.storeFull) return Promise.reject(new DiskFull('full'));
      written.push(event);
      return Promise.resolve({ ...event, id: written.length } as never);
    },
  };
  const options: DiskGuardOptions = {
    clock,
    settings: () => state.settings,
    areas: () => [
      { name: 'data', path: '/data' },
      { name: 'logs', path: '/data/logs' },
    ],
    events,
    logger: quiet,
    probe: () => (state.storeFull ? Promise.reject(new DiskFull('full')) : Promise.resolve()),
    resume: (playId) => {
      resumed.push(playId);
      return Promise.resolve();
    },
    stop: () => stops.push(1),
    freeBytes: () => Promise.resolve(state.free),
  };
  return Object.assign(state, { guard: new DiskGuard(options) });
}

const kinds = (r: Rig): string[] =>
  r.written.map((event) => (event.payload as { kind: string }).kind);

describe('DiskGuard', () => {
  it('is open until a write finds no room, then pauses new work and tells once', async () => {
    const r = rig();
    expect(r.guard.paused()).toBe(false);
    r.guard.report('store', new DiskFull('SQLITE_FULL'));
    r.guard.report('log', new DiskFull('ENOSPC'));
    await r.guard.idle();
    expect(r.guard.paused()).toBe(true);
    expect(r.guard.status().areas).toEqual(['store', 'log']);
    expect(kinds(r)).toEqual(['disk_full']);
    expect(r.written[0]?.payload).toMatchObject({ subject: 'store' });
  });

  it('ignores an error that is not a DiskFull', () => {
    const r = rig();
    r.guard.report('store', new Error('boom'));
    r.guard.report('store', 'text');
    expect(r.guard.status().state).toBe('ok');
  });

  it('takes the raw ENOSPC of a write to a file (the log, a backup) as a full disk too', () => {
    const r = rig();
    r.guard.report('log', Object.assign(new Error('write'), { code: 'ENOSPC' }));
    expect(r.guard.status()).toMatchObject({ state: 'full', areas: ['log'] });
  });

  it('comes back by itself when the space and a write return, resumes the plays it hit and tells', async () => {
    const r = rig();
    r.storeFull = true;
    r.guard.report('store', new DiskFull('x'));
    r.guard.hit('play-a');
    r.guard.hit('play-b');
    await r.guard.tick();
    // Still full: the probe is refused.
    expect(r.guard.paused()).toBe(true);
    expect(r.resumed).toEqual([]);
    r.storeFull = false;
    await r.guard.tick();
    await r.guard.idle();
    expect(r.guard.paused()).toBe(false);
    expect(r.resumed).toEqual(['play-a', 'play-b']);
    // The notice the full store could not take comes first, with its time, then the recovery.
    expect(kinds(r)).toEqual(['disk_full', 'disk_recovered']);
    expect((r.written[0]?.payload as { detail: string }).detail).toContain('(at ');
  });

  it('counts the free space below min_free as a full disk, and needs it back above to recover', async () => {
    const r = rig();
    r.free = 500;
    await r.guard.tick();
    expect(r.guard.paused()).toBe(true);
    expect(r.guard.status().areas).toEqual(['data']);
    r.free = 900;
    await r.guard.tick();
    expect(r.guard.paused()).toBe(true);
    r.free = 5000;
    await r.guard.tick();
    await r.guard.idle();
    expect(r.guard.paused()).toBe(false);
    expect(kinds(r)).toEqual(['disk_full', 'disk_recovered']);
  });

  it('with min_free off it does not read the space', async () => {
    const r = rig({ minFreeBytes: null });
    r.free = 0;
    await r.guard.tick();
    expect(r.guard.paused()).toBe(false);
  });

  it('on_full: continue tells but never closes the gate; stop closes it and asks the daemon to stop', async () => {
    const keep = rig({ onFull: 'continue' });
    keep.guard.report('store', new DiskFull('x'));
    await keep.guard.idle();
    expect(keep.guard.paused()).toBe(false);
    expect(keep.guard.status().state).toBe('full');
    expect(kinds(keep)).toEqual(['disk_full']);
    expect(keep.stops).toEqual([]);

    const stop = rig({ onFull: 'stop' });
    stop.guard.report('store', new DiskFull('x'));
    await stop.guard.idle();
    await Promise.resolve();
    expect(stop.guard.paused()).toBe(true);
    expect(stop.stops).toEqual([1]);
    expect(kinds(stop)).toEqual(['disk_full']);
  });

  it('notify: off writes no event; once writes the end too; every_hour repeats the start each hour', async () => {
    const off = rig({ notify: 'off' });
    off.guard.report('store', new DiskFull('x'));
    off.storeFull = false;
    await off.guard.tick();
    await off.guard.idle();
    expect(off.written).toEqual([]);
    expect(off.guard.paused()).toBe(false);

    const hourly = rig({ notify: 'every_hour' });
    hourly.guard.report('store', new DiskFull('x'));
    hourly.storeFull = true;
    await hourly.guard.tick();
    await hourly.guard.idle();
    expect(kinds(hourly)).toEqual([]);
    hourly.storeFull = false;
    hourly.guard.report('log', new DiskFull('x'));
    await hourly.guard.tick();
    await hourly.guard.idle();
    expect(kinds(hourly)).toEqual(['disk_full', 'disk_recovered']);

    const again = rig({ notify: 'every_hour' });
    again.free = 0;
    await again.guard.tick();
    await again.guard.idle();
    await again.guard.tick();
    await again.guard.idle();
    expect(kinds(again)).toEqual(['disk_full']);
    await again.clock.advance(61 * 60 * 1000);
    await again.guard.tick();
    await again.guard.idle();
    expect(kinds(again)).toEqual(['disk_full', 'disk_full']);
  });

  it('once: a second episode tells again', async () => {
    const r = rig();
    r.guard.report('store', new DiskFull('x'));
    await r.guard.tick();
    await r.guard.idle();
    r.guard.report('store', new DiskFull('x'));
    await r.guard.idle();
    expect(kinds(r)).toEqual(['disk_full', 'disk_recovered', 'disk_full']);
  });

  it('a play that cannot be resumed does not stop the others', async () => {
    const r = rig();
    const seen: string[] = [];
    const guard = new DiskGuard({
      clock: r.clock,
      settings: () => r.settings,
      areas: () => [],
      events: { append: () => Promise.resolve({} as never) },
      logger: quiet,
      resume: (playId) => {
        seen.push(playId);
        return playId === 'bad' ? Promise.reject(new Error('no')) : Promise.resolve();
      },
    });
    guard.report('store', new DiskFull('x'));
    guard.hit('bad');
    guard.hit('good');
    await guard.tick();
    expect(seen).toEqual(['bad', 'good']);
    expect(guard.paused()).toBe(false);
  });

  it('a folder that does not take a write keeps the disk full even when the space read looks fine', async () => {
    const r = rig();
    let logFull = true;
    const guard = new DiskGuard({
      clock: r.clock,
      settings: () => r.settings,
      areas: () => [{ name: 'log', path: '/data/logs' }],
      events: { append: () => Promise.resolve({} as never) },
      logger: quiet,
      freeBytes: () => Promise.resolve(1_000_000),
      probeArea: () =>
        logFull
          ? Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }))
          : Promise.resolve(),
    });
    guard.report('log', Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await guard.tick();
    expect(guard.status().state).toBe('full');
    logFull = false;
    await guard.tick();
    expect(guard.status().state).toBe('ok');
  });
});

describe('probeFolder', () => {
  it('writes a file and removes it, and takes a folder that is not there for granted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'otheater-probe-'));
    try {
      await probeFolder({ name: 'log', path: dir });
      expect(readdirSync(dir)).toEqual([]);
      await expect(
        probeFolder({ name: 'log', path: join(dir, 'missing') }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
