// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeKeys } from '../release-fixture.js';
import { parsePublicKey } from '../verify.js';
import { writeJournal, type UpdateJournal } from './journal.js';
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
