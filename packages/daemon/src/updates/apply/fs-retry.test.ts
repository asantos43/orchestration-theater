// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retryFs, isTransientFsError, type FsRetryPolicy } from './fs-retry.js';
import { writeJournal, readJournal, type UpdateJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { placeStaged } from './swap.js';

/** The refusals Windows gives while another process still holds a file (Phase 10, P12). */

const refusal = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** A clock that only moves when the policy sleeps. */
function fakeTime(): { policy: FsRetryPolicy; slept: number[] } {
  let at = 0;
  const slept: number[] = [];
  return {
    slept,
    policy: {
      mode: 'always',
      now: () => at,
      sleep: (ms) => {
        slept.push(ms);
        at += ms;
        return Promise.resolve();
      },
    },
  };
}

describe('retryFs', () => {
  it('repeats a call that is refused for a moment, with a growing wait', async () => {
    const { policy, slept } = fakeTime();
    const told: number[] = [];
    let calls = 0;
    const result = await retryFs(
      'rename',
      () => {
        calls += 1;
        return calls < 4 ? Promise.reject(refusal('EPERM')) : Promise.resolve('done');
      },
      { ...policy, onRetry: (info) => told.push(info.attempt) },
    );
    expect(result).toBe('done');
    expect(calls).toBe(4);
    expect(slept).toEqual([25, 50, 100]);
    expect(told).toEqual([1, 2, 3]);
  });

  it('retries EBUSY and EACCES too, and only those', async () => {
    expect(isTransientFsError(refusal('EBUSY'))).toBe(true);
    expect(isTransientFsError(refusal('EACCES'))).toBe(true);
    expect(isTransientFsError(refusal('ENOENT'))).toBe(false);
    expect(isTransientFsError(new Error('plain'))).toBe(false);
    const { policy, slept } = fakeTime();
    let calls = 0;
    await expect(
      retryFs(
        'rename',
        () => {
          calls += 1;
          return Promise.reject(refusal('ENOENT'));
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('gives up after the timeout and throws the last error as it came', async () => {
    const { policy, slept } = fakeTime();
    let calls = 0;
    await expect(
      retryFs(
        'rename',
        () => {
          calls += 1;
          return Promise.reject(refusal('EPERM'));
        },
        { ...policy, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBeGreaterThan(2);
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1500);
    expect(Math.max(...slept)).toBe(500);
  });

  it('is on only on Windows in auto mode, always in `always`, never in `off`', async () => {
    const attempt = async (policy: FsRetryPolicy): Promise<number> => {
      let calls = 0;
      await retryFs(
        'rename',
        () => {
          calls += 1;
          return calls < 2 ? Promise.reject(refusal('EPERM')) : Promise.resolve();
        },
        { ...fakeTime().policy, ...policy },
      ).catch(() => undefined);
      return calls;
    };
    expect(await attempt({ mode: 'auto', platform: 'win32' })).toBe(2);
    expect(await attempt({ mode: 'auto', platform: 'linux' })).toBe(1);
    expect(await attempt({ mode: 'always' })).toBe(2);
    expect(await attempt({ mode: 'off' })).toBe(1);
  });
});

describe('the swap and the journal', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('placeStaged still fails at once on an error that is not a hold of the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ot-fs-retry-'));
    dirs.push(dir);
    const layout = layoutOf(join(dir, 'ot'));
    await mkdir(layout.stagingDir, { recursive: true });
    await writeFile(layout.stagingExe, 'new');
    // A directory where the executable should go: the rename fails with a code that is no hold of the file.
    await mkdir(layout.exe);
    await expect(placeStaged(layout, { mode: 'always', timeoutMs: 50 })).rejects.toThrow();
    expect(await readFile(layout.stagingExe, 'utf8')).toBe('new');
  });

  it('writeJournal and readJournal accept a policy and keep their behaviour without a refusal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ot-fs-retry-'));
    dirs.push(dir);
    const file = join(dir, 'update-state.json');
    const journal: UpdateJournal = {
      v: 1,
      from: '1.0.0',
      to: '1.0.1',
      sha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      step: 'waiting',
      oldPid: 0,
      applierPid: 0,
      dataDir: join(dir, 'data'),
      exe: join(dir, 'ot'),
      rollback: 'auto',
      healthTimeoutMs: 1000,
      stableMs: 0,
      backup: null,
      reason: null,
      reported: false,
      startedAt: 1,
      updatedAt: 1,
    };
    await writeJournal(file, journal, { mode: 'always' });
    expect(await readJournal(file, { mode: 'always' })).toEqual({ kind: 'ok', journal });
    expect(await readJournal(join(dir, 'absent.json'), { mode: 'always' })).toEqual({
      kind: 'none',
    });
  });
});
