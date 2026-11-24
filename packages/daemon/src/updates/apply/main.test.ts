// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retryFs, type FsRetryPolicy } from './fs-retry.js';
import { makeKeys } from '../release-fixture.js';
import { parsePublicKey } from '../verify.js';
import { JournalSchema, readJournal, writeJournal, type UpdateJournal } from './journal.js';
import { layoutOf } from './layout.js';
import { APPLY_EXIT_USAGE, runApplyUpdate } from './main.js';
import { realApplyPorts } from './real-ports.js';
import { writeProof } from './trust-fixture.js';

/** The journal the applier is given is not followed unless a signed manifest backs it (Phase 11, P8a). */

const dirs: string[] = [];
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(async () => {
  process.exitCode = exitCode;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function install(): Promise<{ dir: string; layout: ReturnType<typeof layoutOf> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-apply-main-'));
  dirs.push(dir);
  const layout = layoutOf(join(dir, 'ot'));
  await writeFile(layout.exe, '#!/bin/sh\n');
  return { dir, layout };
}

const journalOf = (
  exe: string,
  dataDir: string,
  over: Partial<UpdateJournal> = {},
): UpdateJournal => ({
  v: 1,
  from: '0.5.0',
  to: '0.6.0',
  sha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  step: 'waiting',
  oldPid: 0,
  applierPid: 0,
  dataDir,
  exe,
  rollback: 'auto',
  healthTimeoutMs: 1000,
  stableMs: 0,
  backup: null,
  reason: null,
  reported: false,
  startedAt: 1,
  updatedAt: 1,
  ...over,
});

describe('runApplyUpdate', () => {
  it('refuses a journal that no signed manifest backs, and moves nothing', async () => {
    const { dir, layout } = await install();
    const forged = journalOf(layout.exe, join(dir, 'data'));
    await writeJournal(layout.journal, forged);
    const trust = { key: parsePublicKey(makeKeys().publicPem), platform: 'linux-x64' };
    await runApplyUpdate(['--journal', layout.journal], { trust });
    expect(process.exitCode).toBe(APPLY_EXIT_USAGE);
    expect(JSON.parse(await readFile(layout.journal, 'utf8'))).toMatchObject({ step: 'waiting' });
    await expect(readFile(layout.previousExe)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a proof made with another key is not accepted either', async () => {
    const { dir, layout } = await install();
    const manifestSha256 = await writeProof(layout, makeKeys(), {
      version: '0.6.0',
      sha256: 'a'.repeat(64),
    });
    await writeJournal(
      layout.journal,
      journalOf(layout.exe, join(dir, 'data'), { manifestSha256 }),
    );
    const trust = { key: parsePublicKey(makeKeys().publicPem), platform: 'linux-x64' };
    await runApplyUpdate(['--journal', layout.journal], { trust });
    expect(process.exitCode).toBe(APPLY_EXIT_USAGE);
  });
});

describe('the backup the journal names', () => {
  it('is restored only from inside the backup folder of the configuration', async () => {
    const { dir, layout } = await install();
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true });
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const ports = realApplyPorts({
      layout,
      journal: journalOf(layout.exe, dataDir),
      logger,
      // Never used by a restore.
      service: undefined,
    });
    for (const outside of [
      dir,
      dataDir,
      join(dataDir, 'backups'),
      join(dataDir, 'elsewhere', 'x'),
      join(dataDir, 'backups', '..', 'x'),
      '/',
    ]) {
      await expect(ports.restoreBackup(outside)).rejects.toThrow(/not inside the backup folder/);
    }
    // Inside, the confinement lets it through (and the restore itself finds no backup there).
    await expect(ports.restoreBackup(join(dataDir, 'backups', 'otheater-x'))).rejects.not.toThrow(
      /not inside the backup folder/,
    );
  });
});

describe('the file-call repetition the journal asks for (N305)', () => {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const refusal = (): NodeJS.ErrnoException =>
    Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

  /** Runs a call that is always refused, on a clock that only moves when the policy sleeps. */
  async function refusedCalls(
    policy: FsRetryPolicy | undefined,
    platform: NodeJS.Platform,
  ): Promise<{ calls: number; waitedMs: number }> {
    let at = 0;
    let calls = 0;
    await retryFs(
      'rename',
      () => {
        calls += 1;
        return Promise.reject(refusal());
      },
      {
        ...policy,
        platform,
        now: () => at,
        sleep: (ms) => {
          at += ms;
          return Promise.resolve();
        },
      },
    ).catch(() => undefined);
    return { calls, waitedMs: at };
  }

  async function portsFor(over: Partial<UpdateJournal>) {
    const { dir, layout } = await install();
    return realApplyPorts({
      layout,
      journal: journalOf(layout.exe, join(dir, 'data'), over),
      logger,
    });
  }

  it('off does not repeat, not even on Windows', async () => {
    const ports = await portsFor({ fsRetry: 'off' });
    expect(await refusedCalls(ports.fsRetry, 'win32')).toEqual({ calls: 1, waitedMs: 0 });
  });

  it('always repeats on a system that is not Windows, until the limit of the journal', async () => {
    const ports = await portsFor({ fsRetry: 'always', fsRetryTimeoutMs: 2000 });
    const { calls, waitedMs } = await refusedCalls(ports.fsRetry, 'linux');
    expect(calls).toBeGreaterThan(3);
    expect(waitedMs).toBeGreaterThanOrEqual(2000);
    expect(waitedMs).toBeLessThan(2000 + 500 + 1);
  });

  it('auto decides by the system', async () => {
    const ports = await portsFor({ fsRetry: 'auto', fsRetryTimeoutMs: 1000 });
    expect((await refusedCalls(ports.fsRetry, 'linux')).calls).toBe(1);
    expect((await refusedCalls(ports.fsRetry, 'darwin')).calls).toBe(1);
    expect((await refusedCalls(ports.fsRetry, 'win32')).calls).toBeGreaterThan(3);
  });

  it('the time of the journal is the limit the applier waits', async () => {
    const short = await portsFor({ fsRetry: 'always', fsRetryTimeoutMs: 1000 });
    const long = await portsFor({ fsRetry: 'always', fsRetryTimeoutMs: 30_000 });
    const a = await refusedCalls(short.fsRetry, 'linux');
    const b = await refusedCalls(long.fsRetry, 'linux');
    expect(a.waitedMs).toBeGreaterThanOrEqual(1000);
    expect(a.waitedMs).toBeLessThan(1501);
    expect(b.waitedMs).toBeGreaterThanOrEqual(30_000);
    expect(b.waitedMs).toBeLessThan(30_501);
  });

  it('a journal from before the keys (neither field) uses auto and 15 s', async () => {
    const { dir, layout } = await install();
    const old: Record<string, unknown> = { ...journalOf(layout.exe, join(dir, 'data')) };
    delete old.fsRetry;
    delete old.fsRetryTimeoutMs;
    await writeFile(layout.journal, JSON.stringify(old));
    const reading = await readJournal(layout.journal);
    if (reading.kind !== 'ok') throw new Error('the old journal was not read');
    const { journal } = reading;
    expect(journal.fsRetry).toBeUndefined();
    expect(journal.fsRetryTimeoutMs).toBeUndefined();
    const ports = realApplyPorts({ layout, journal, logger });
    expect((await refusedCalls(ports.fsRetry, 'linux')).calls).toBe(1);
    const onWindows = await refusedCalls(ports.fsRetry, 'win32');
    expect(onWindows.calls).toBeGreaterThan(3);
    expect(onWindows.waitedMs).toBeGreaterThanOrEqual(15_000);
    expect(onWindows.waitedMs).toBeLessThan(15_501);
  });

  it('the journal refuses a mode that does not exist and a time of zero', () => {
    const base = journalOf('/x/ot', '/x/data');
    expect(JournalSchema.safeParse({ ...base, fsRetry: 'sometimes' }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...base, fsRetryTimeoutMs: 0 }).success).toBe(false);
    expect(JournalSchema.safeParse({ ...base, fsRetry: 'off', fsRetryTimeoutMs: 1 }).success).toBe(
      true,
    );
  });
});
