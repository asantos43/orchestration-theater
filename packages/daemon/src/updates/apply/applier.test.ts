// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverInterrupted, runApply, type ApplyPorts } from './applier.js';
import type { HealthReading } from './health.js';
import { readJournal, writeJournal, type JournalStep, type UpdateJournal } from './journal.js';
import { layoutOf, type InstallLayout } from './layout.js';
import { sha256OfFile } from '../verify.js';

const run = promisify(execFile);

/**
 * The swap over a temporary folder: real files, real moves, and executables that are scripts (a
 * script prints what the "daemon" of that version does). Only the daemon, the health look and the
 * clock are fakes. Scripts do not run on Windows, so the file is skipped there.
 */
const posix = process.platform !== 'win32';

const OLD_DAEMON = '#!/bin/sh\necho ok\n';
const NEW_OK = '#!/bin/sh\necho ok\n# new\n';
const NEW_FAILS = '#!/bin/sh\necho fail\nexit 1\n';
const NEW_SICK = '#!/bin/sh\necho sick\n# new\n';
const NEW_FLAKY = '#!/bin/sh\necho flaky\n# new\n';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Rig {
  readonly layout: InstallLayout;
  readonly ports: ApplyPorts;
  readonly journal: UpdateJournal;
  readonly calls: string[];
  readonly alive: Set<number>;
  readonly started: string[];
  /** What the fake daemon of the moment answers to the health look. */
  state: { current: 'none' | 'ok' | 'sick' | 'flaky'; looks: number };
}

async function put(file: string, body: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

async function rig(
  options: {
    staged?: string | undefined;
    rollback?: 'auto' | 'off';
    backup?: string | null;
    oldPid?: number;
    oldStaysAlive?: boolean;
    healthTimeoutMs?: number;
    stableMs?: number;
  } = {},
): Promise<Rig> {
  const folder = await mkdtemp(join(tmpdir(), 'ot-apply-'));
  folders.push(folder);
  const layout = layoutOf(join(folder, 'ot'));
  await put(layout.exe, OLD_DAEMON);
  await put(layout.stagingExe, options.staged ?? NEW_OK);
  const alive = new Set<number>(options.oldPid === undefined ? [] : [options.oldPid]);
  if (options.oldStaysAlive !== true) alive.clear();
  const calls: string[] = [];
  const started: string[] = [];
  const state: Rig['state'] = { current: 'ok', looks: 0 };
  let now = 1_000;
  const ports: ApplyPorts = {
    clock: {
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
    isAlive: (pid) => alive.has(pid),
    startDaemon: async () => {
      const result = await run(layout.exe, []).then(
        (done) => done.stdout.trim(),
        () => 'fail',
      );
      calls.push(`start:${result}`);
      started.push(await readFile(layout.exe, 'utf8'));
      if (result === 'fail') return { ok: false, detail: 'the process ended with an error' };
      state.current = result === 'sick' || result === 'flaky' ? result : 'ok';
      state.looks = 0;
      return { ok: true };
    },
    stopDaemon: () => {
      calls.push('stop');
      state.current = 'none';
      return Promise.resolve();
    },
    probe: () => {
      state.looks += 1;
      let reading: HealthReading = 'down';
      if (state.current === 'ok') reading = 'ok';
      if (state.current === 'sick') reading = 'unhealthy';
      if (state.current === 'flaky') reading = state.looks <= 2 ? 'ok' : 'down';
      return Promise.resolve(reading);
    },
    restoreBackup: (dir) => {
      calls.push(`restore:${dir}`);
      return Promise.resolve();
    },
    sha256: sha256OfFile,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    oldExitTimeoutMs: 5000,
    pollMs: 100,
  };
  const journal: UpdateJournal = {
    v: 1,
    from: '0.5.0',
    to: '0.6.0',
    sha256: await sha256OfFile(layout.stagingExe),
    step: 'waiting',
    oldPid: options.oldPid ?? 0,
    applierPid: 0,
    dataDir: join(folder, 'data'),
    exe: layout.exe,
    rollback: options.rollback ?? 'auto',
    healthTimeoutMs: options.healthTimeoutMs ?? 2000,
    stableMs: options.stableMs ?? 500,
    backup: options.backup ?? null,
    reason: null,
    reported: false,
    startedAt: 1_000,
    updatedAt: 1_000,
  };
  await writeJournal(layout.journal, journal);
  return { layout, ports, journal, calls, alive, started, state };
}

async function step(layout: InstallLayout): Promise<JournalStep | undefined> {
  const reading = await readJournal(layout.journal);
  return reading.kind === 'ok' ? reading.journal.step : undefined;
}

async function present(file: string): Promise<boolean> {
  return await stat(file).then(
    () => true,
    () => false,
  );
}

describe.skipIf(!posix)('the swap', () => {
  it('puts the new executable in place, keeps the old one at previous/ and commits', async () => {
    const r = await rig();
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'committed' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(NEW_OK);
    expect(await readFile(r.layout.previousExe, 'utf8')).toBe(OLD_DAEMON);
    expect(await present(r.layout.stagingDir)).toBe(false);
    expect(await step(r.layout)).toBe('committed');
    expect(r.calls).toEqual(['start:ok']);
    const reading = await readJournal(r.layout.journal);
    expect(reading.kind === 'ok' && reading.journal.reported).toBe(false);
  });

  it('waits for the old daemon to end before it moves anything', async () => {
    const r = await rig({ oldPid: 4242, oldStaysAlive: true });
    // The old daemon ends after a few looks of the applier.
    let looks = 0;
    const ports: ApplyPorts = {
      ...r.ports,
      isAlive: (pid) => {
        looks += 1;
        if (looks > 3) r.alive.delete(4242);
        return r.alive.has(pid);
      },
    };
    expect(await runApply(r.layout, ports, r.journal)).toEqual({ kind: 'committed' });
    expect(looks).toBeGreaterThan(3);
    expect(await readFile(r.layout.exe, 'utf8')).toBe(NEW_OK);
  });

  it('keeps only one previous: a second swap replaces it', async () => {
    const r = await rig();
    await runApply(r.layout, r.ports, r.journal);
    await put(r.layout.stagingExe, `${NEW_OK}# newer\n`);
    const second = {
      ...r.journal,
      from: '0.6.0',
      to: '0.7.0',
      sha256: await sha256OfFile(r.layout.stagingExe),
    };
    await runApply(r.layout, r.ports, second);
    expect(await readFile(r.layout.previousExe, 'utf8')).toBe(NEW_OK);
    expect(await readFile(r.layout.exe, 'utf8')).toBe(`${NEW_OK}# newer\n`);
  });
});

describe.skipIf(!posix)('the rollback', () => {
  it('takes the old version back when the new one does not start', async () => {
    const r = await rig({ staged: NEW_FAILS });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'rolled_back', reason: 'not_started' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    expect(await present(r.layout.previousExe)).toBe(false);
    expect(await step(r.layout)).toBe('rolled_back');
    // The new one failed to start; the old daemon was started again.
    expect(r.calls).toEqual(['start:fail', 'stop', 'start:ok']);
    expect(r.started.at(-1)).toBe(OLD_DAEMON);
  });

  it('takes the old version back when the health never turns good', async () => {
    const r = await rig({ staged: NEW_SICK, healthTimeoutMs: 1000 });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'rolled_back', reason: 'health' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    expect(r.calls).toEqual(['start:sick', 'stop', 'start:ok']);
  });

  it('takes the old version back when the daemon drops inside the stable window', async () => {
    const r = await rig({ staged: NEW_FLAKY, stableMs: 2000 });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'rolled_back', reason: 'unstable' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
  });

  it('puts the backup of the migration back, with the daemon stopped, before the executable', async () => {
    const r = await rig({ staged: NEW_FAILS, backup: '/backups/2026-11-22-pre-update' });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome.kind).toBe('rolled_back');
    expect(r.calls).toEqual([
      'start:fail',
      'stop',
      'restore:/backups/2026-11-22-pre-update',
      'start:ok',
    ]);
  });

  it('does not touch the backup when none was made', async () => {
    const r = await rig({ staged: NEW_FAILS });
    await runApply(r.layout, r.ports, r.journal);
    expect(r.calls.some((call) => call.startsWith('restore:'))).toBe(false);
  });

  it('rollback: off leaves the new version and says it failed', async () => {
    const r = await rig({ staged: NEW_FAILS, rollback: 'off', backup: '/backups/x' });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'failed', reason: 'not_started' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(NEW_FAILS);
    expect(await step(r.layout)).toBe('failed');
    expect(r.calls).toEqual(['start:fail']);
  });

  it('moves nothing when the old daemon does not end', async () => {
    const r = await rig({ oldPid: 4242, oldStaysAlive: true });
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'rolled_back', reason: 'swap_failed' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    expect(await present(r.layout.previousExe)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('moves nothing when the staged file is not the one that was checked', async () => {
    const r = await rig();
    await put(r.layout.stagingExe, '#!/bin/sh\necho ok\n# swapped\n');
    const outcome = await runApply(r.layout, r.ports, r.journal);
    expect(outcome).toEqual({ kind: 'rolled_back', reason: 'hash_changed' });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    // The old daemon was gone (pid 0): it is started again.
    expect(r.calls).toEqual(['start:ok']);
  });
});

describe.skipIf(!posix)('an applier that died half way (the journal)', () => {
  async function stoppedAt(
    r: Rig,
    stepName: JournalStep,
    files: { previous?: boolean; newInPlace?: boolean },
  ): Promise<void> {
    if (files.previous === true) await put(r.layout.previousExe, OLD_DAEMON);
    if (files.newInPlace === true) {
      await put(r.layout.exe, NEW_OK);
      await rm(r.layout.stagingDir, { recursive: true, force: true });
    }
    await writeJournal(r.layout.journal, {
      ...r.journal,
      step: stepName,
      applierPid: 999_999,
      sha256: files.newInPlace === true ? await sha256OfFile(r.layout.exe) : r.journal.sha256,
    });
  }

  it('waiting: nothing was moved, the link is undone', async () => {
    const r = await rig();
    await stoppedAt(r, 'waiting', { previous: true });
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result).toEqual({
      kind: 'finished',
      outcome: { kind: 'rolled_back', reason: 'interrupted' },
    });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    expect(await present(r.layout.previousExe)).toBe(false);
    expect(await step(r.layout)).toBe('rolled_back');
  });

  it('linked, the new executable not yet in place: the link is undone', async () => {
    const r = await rig();
    await stoppedAt(r, 'linked', { previous: true });
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result).toEqual({
      kind: 'finished',
      outcome: { kind: 'rolled_back', reason: 'interrupted' },
    });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
  });

  it('linked, the new executable already in place: it goes on, and keeps a version that is healthy', async () => {
    const r = await rig();
    await stoppedAt(r, 'linked', { previous: true, newInPlace: true });
    r.state.current = 'ok';
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result).toEqual({ kind: 'finished', outcome: { kind: 'committed' } });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(NEW_OK);
  });

  it.each(['placed', 'starting', 'checking'] as const)(
    '%s: a new version that does not answer is taken back',
    async (name) => {
      const r = await rig();
      await stoppedAt(r, name, { previous: true, newInPlace: true });
      r.state.current = 'none';
      const result = await recoverInterrupted(r.layout, r.ports, false);
      expect(result).toEqual({
        kind: 'finished',
        outcome: { kind: 'rolled_back', reason: 'interrupted' },
      });
      expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
      // The CLI that found the journal leaves the old daemon alone.
      expect(r.calls).toEqual(['stop']);
    },
  );

  it('placed: a new version that answers is kept', async () => {
    const r = await rig();
    await stoppedAt(r, 'placed', { previous: true, newInPlace: true });
    r.state.current = 'ok';
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result).toEqual({ kind: 'finished', outcome: { kind: 'committed' } });
    expect(await step(r.layout)).toBe('committed');
  });

  it('rolling_back: finishes the rollback and the backup too', async () => {
    const r = await rig({ backup: '/backups/y' });
    await stoppedAt(r, 'rolling_back', { previous: true, newInPlace: true });
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result.kind).toBe('finished');
    expect(await readFile(r.layout.exe, 'utf8')).toBe(OLD_DAEMON);
    expect(r.calls).toEqual(['stop', 'restore:/backups/y']);
  });

  it('rollback: off leaves a new version that does not answer, as failed', async () => {
    const r = await rig({ rollback: 'off' });
    await stoppedAt(r, 'checking', { previous: true, newInPlace: true });
    r.state.current = 'none';
    const result = await recoverInterrupted(r.layout, r.ports, false);
    expect(result).toEqual({
      kind: 'finished',
      outcome: { kind: 'failed', reason: 'interrupted' },
    });
    expect(await readFile(r.layout.exe, 'utf8')).toBe(NEW_OK);
  });

  it('does not touch a swap whose applier is still alive', async () => {
    const r = await rig();
    await stoppedAt(r, 'checking', { previous: true, newInPlace: true });
    r.alive.add(999_999);
    expect(await recoverInterrupted(r.layout, r.ports, false)).toEqual({ kind: 'running' });
    expect(await step(r.layout)).toBe('checking');
  });

  it('does nothing with a swap that ended, with no journal, or with a journal it cannot read', async () => {
    const r = await rig();
    await stoppedAt(r, 'committed', {});
    expect(await recoverInterrupted(r.layout, r.ports, false)).toEqual({ kind: 'none' });
    await rm(r.layout.journal);
    expect(await recoverInterrupted(r.layout, r.ports, false)).toEqual({ kind: 'none' });
    await writeFile(r.layout.journal, '{not json');
    expect(await recoverInterrupted(r.layout, r.ports, false)).toEqual({ kind: 'corrupt' });
    expect(await readFile(r.layout.journal, 'utf8')).toBe('{not json');
  });
});
