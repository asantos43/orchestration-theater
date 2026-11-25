// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TEMPORARY_CLEANUP_MODE,
  DEFAULT_TEMPORARY_MAX_AGE_MS,
  TEMPORARY_CLEANUP_MODES,
  configureTemporaryCleanup,
  onTemporarySweepFailure,
  reportTemporarySweepFailure,
  sweepTemporaries,
  sweepTemporariesSync,
  temporaryCleanupPolicy,
  temporaryPathOf,
  type TemporaryShape,
} from './temporaries.js';

const HEX = '0123456789abcdef0123456789abcdef';
const DEAD = 2_000_000_000;
const NOW = 1_800_000_000_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-temporaries-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every shape of temporary the code writes, with the write that makes it (N306). */
const SHAPES: readonly {
  readonly point: string;
  readonly target: string;
  readonly shape: TemporaryShape;
}[] = [
  {
    point: 'writePrivateFile (api files, layout, ATIF export)',
    target: 'daemon-id',
    shape: { hexLength: 16 },
  },
  {
    point: 'writePrivateFileAtomic (client.json, plugin registry)',
    target: 'plugins.json',
    shape: { hexLength: 8 },
  },
  { point: 'config edit', target: 'config.yaml', shape: { hexLength: 8 } },
  { point: 'extractNative', target: 'addon.node', shape: { hexLength: 12, hidden: true } },
  {
    point: 'update journal, ATIF exporter, lock info',
    target: 'update-state.json',
    shape: { hexLength: 0 },
  },
  { point: 'profile shim', target: 'ot-claude-work', shape: { hexLength: 0, hidden: true } },
];

function nameOf(target: string, shape: TemporaryShape, pid: number): string {
  const hex = shape.hexLength > 0 ? `.${HEX.slice(0, shape.hexLength)}` : '';
  return `${shape.hidden === true ? '.' : ''}${target}.${String(pid)}${hex}.tmp`;
}

async function age(name: string, ms: number): Promise<void> {
  const at = new Date(NOW - ms);
  await utimes(join(dir, name), at, at);
}

function deadPid(): number {
  // The pid of a process that has already ended.
  const pid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
  return pid;
}

describe.each(SHAPES)('sweepTemporaries: $point', ({ target, shape }) => {
  const path = (): string => join(dir, target);
  const options = (extra: object = {}): Parameters<typeof sweepTemporaries>[1] => ({
    ...shape,
    ...extra,
  });

  it('removes the temporary of a dead pid and keeps the one of a live pid, in both flavours', async () => {
    const gone = nameOf(target, shape, deadPid());
    const live = nameOf(target, shape, process.ppid);
    await writeFile(path(), 'whole');
    await writeFile(join(dir, gone), 'half');
    await writeFile(join(dir, live), 'in flight');
    expect(await sweepTemporaries(path(), options({ policy: { mode: 'pid' } }))).toEqual([gone]);
    expect((await readdir(dir)).sort()).toEqual([live, target].sort());
    await writeFile(join(dir, gone), 'half');
    expect(sweepTemporariesSync(path(), options({ policy: { mode: 'pid' } }))).toEqual([gone]);
    expect((await readdir(dir)).sort()).toEqual([live, target].sort());
  });

  it('keeps the own pid unless it is the start-up (a container runs the daemon as pid 1)', async () => {
    const own = nameOf(target, shape, process.pid);
    await writeFile(join(dir, own), 'in flight');
    expect(await sweepTemporaries(path(), options())).toEqual([]);
    expect(await sweepTemporaries(path(), options({ includeOwnPid: true }))).toEqual([own]);
  });

  it('in age mode removes the old one and keeps the new one, whatever the pid says', async () => {
    const old = nameOf(target, shape, process.ppid);
    const fresh = nameOf(target, shape, deadPid());
    await writeFile(join(dir, old), 'old');
    await writeFile(join(dir, fresh), 'new');
    await age(old, 2 * 60 * 60_000);
    await age(fresh, 5 * 60_000);
    const policy = { mode: 'age', maxAgeMs: 60 * 60_000 } as const;
    expect(await sweepTemporaries(path(), options({ policy, now: () => NOW }))).toEqual([old]);
    expect(await readdir(dir)).toEqual([fresh]);
    await age(fresh, 2 * 60 * 60_000);
    expect(sweepTemporariesSync(path(), options({ policy, now: () => NOW }))).toEqual([fresh]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('with the cleaning off removes nothing', async () => {
    const gone = nameOf(target, shape, DEAD);
    await writeFile(join(dir, gone), 'half');
    expect(await sweepTemporaries(path(), options({ policy: { mode: 'off' } }))).toEqual([]);
    expect(sweepTemporariesSync(path(), options({ policy: { mode: 'off' } }))).toEqual([]);
    expect(await readdir(dir)).toEqual([gone]);
  });

  it('never touches a name outside its pattern, nor a temporary of another file', async () => {
    const hex = shape.hexLength > 0 ? `.${HEX.slice(0, shape.hexLength)}` : '';
    const dot = shape.hidden === true ? '.' : '';
    const wrongHex = shape.hexLength > 0 ? '' : `.${HEX.slice(0, 8)}`;
    const keep = [
      target,
      `${dot}${target}.${String(DEAD)}${wrongHex}${hex}.tmp.old`,
      `${dot}${target}.${String(DEAD)}${hex}`,
      `${dot}${target}.abc${hex}.tmp`,
      `${dot}${target}.0${hex}.tmp`,
      `${dot}${target}.${String(DEAD)}${wrongHex}.tmp`,
      `${dot}other.${String(DEAD)}${hex}.tmp`,
      `x${dot}${target}.${String(DEAD)}${hex}.tmp`,
      `${shape.hidden === true ? '' : '.'}${target}.${String(DEAD)}${hex}.tmp`,
    ];
    for (const name of new Set(keep)) await writeFile(join(dir, name), 'keep');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', nameOf(target, shape, DEAD)), 'keep');
    const before = (await readdir(dir)).sort();
    for (const mode of ['pid', 'age'] as const) {
      const policy = { mode, maxAgeMs: 60_000 };
      await sweepTemporaries(
        path(),
        options({ policy, now: () => NOW + 10 * 86_400_000, alive: () => false }),
      );
      expect((await readdir(dir)).sort()).toEqual(before);
    }
  });

  it('reports a temporary it cannot remove and goes on, and a missing folder is not a failure', async () => {
    // A folder with the name of a temporary cannot be removed as a file: the removal fails.
    const stuck = nameOf(target, shape, DEAD);
    const next = nameOf(target, shape, DEAD + 1);
    await mkdir(join(dir, stuck));
    await writeFile(join(dir, join(stuck, 'inside')), 'x').catch(() => undefined);
    await writeFile(join(dir, next), 'half');
    const onError = vi.fn();
    const removed = await sweepTemporaries(
      path(),
      options({ policy: { mode: 'pid' }, alive: () => false, onError }),
    );
    expect(removed).toEqual([next]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe(stuck);
    const quiet = vi.fn();
    expect(await sweepTemporaries(join(dir, 'gone', target), options({ onError: quiet }))).toEqual(
      [],
    );
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('the failure sink', () => {
  it('sends a failure to the sink, and one that came before the sink is delivered in order', () => {
    const seen: string[] = [];
    reportTemporarySweepFailure({ name: 'first', error: new Error('a') });
    const stop = onTemporarySweepFailure((failure) => seen.push(failure.name));
    reportTemporarySweepFailure({ name: 'second', error: new Error('b') });
    expect(seen).toEqual(['first', 'second']);
    stop();
  });

  it('does not let a sink that throws break the write it reports about', async () => {
    const stop = onTemporarySweepFailure(() => {
      throw new Error('the sink broke');
    });
    await mkdir(join(dir, `a.${String(DEAD)}.tmp`));
    await expect(
      sweepTemporaries(join(dir, 'a'), {
        hexLength: 0,
        policy: { mode: 'pid' },
        alive: () => false,
      }),
    ).resolves.toEqual([]);
    stop();
  });

  it('a failure without a handler goes to the sink', async () => {
    const seen: string[] = [];
    const stop = onTemporarySweepFailure((failure) => seen.push(failure.name));
    await mkdir(join(dir, `a.${String(DEAD)}.tmp`));
    await sweepTemporaries(join(dir, 'a'), {
      hexLength: 0,
      policy: { mode: 'pid' },
      alive: () => false,
    });
    stop();
    expect(seen).toEqual([`a.${String(DEAD)}.tmp`]);
  });
});

describe('the policy', () => {
  it('is pid with one hour until the daemon sets it, and the last one set wins until it is taken back', () => {
    expect(temporaryCleanupPolicy()).toEqual({
      mode: DEFAULT_TEMPORARY_CLEANUP_MODE,
      maxAgeMs: DEFAULT_TEMPORARY_MAX_AGE_MS,
    });
    expect(TEMPORARY_CLEANUP_MODES).toEqual(['off', 'pid', 'age']);
    const first = configureTemporaryCleanup({ mode: 'age', maxAgeMs: 120_000 });
    const second = configureTemporaryCleanup({ mode: 'off' });
    expect(temporaryCleanupPolicy()).toEqual({
      mode: 'off',
      maxAgeMs: DEFAULT_TEMPORARY_MAX_AGE_MS,
    });
    second();
    expect(temporaryCleanupPolicy()).toEqual({ mode: 'age', maxAgeMs: 120_000 });
    first();
    expect(temporaryCleanupPolicy().mode).toBe('pid');
  });

  it('is the one a sweep uses when none is passed', async () => {
    const name = `a.${String(process.ppid)}.tmp`;
    await writeFile(join(dir, name), 'x');
    await age(name, 2 * 60 * 60_000);
    expect(await sweepTemporaries(join(dir, 'a'), { hexLength: 0, now: () => NOW })).toEqual([]);
    const stop = configureTemporaryCleanup({ mode: 'age', maxAgeMs: 60 * 60_000 });
    try {
      expect(await sweepTemporaries(join(dir, 'a'), { hexLength: 0, now: () => NOW })).toEqual([
        name,
      ]);
    } finally {
      stop();
    }
  });
});

describe('temporaryPathOf', () => {
  it('puts this pid in the name, in the folder of the target, in the shape asked for', () => {
    const pid = String(process.pid);
    expect(temporaryPathOf(join(dir, 'f'), { hexLength: 0 })).toBe(join(dir, `f.${pid}.tmp`));
    expect(temporaryPathOf(join(dir, 'f'), { hexLength: 0, hidden: true })).toBe(
      join(dir, `.f.${pid}.tmp`),
    );
    expect(temporaryPathOf(join(dir, 'f'), { hexLength: 8 })).toMatch(
      new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/f\\.${pid}\\.[0-9a-f]{8}\\.tmp$`),
    );
  });
});
