// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureProfileFiles, profileLayout } from './profile.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-opencode-temporaries-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The pid of a process that has already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

describe('ensureProfileFiles and the orphan temporaries (N306)', () => {
  it('removes the orphan of a dead pid, also when the file needs no write, and keeps the rest', async () => {
    await ensureProfileFiles(dir);
    const target = profileLayout(dir).configFile;
    const folder = dirname(target);
    const file = basename(target);
    const orphan = `${file}.${String(deadPid())}.0123456789abcdef.tmp`;
    const live = `${file}.${String(process.ppid)}.0123456789abcdef.tmp`;
    const legacy = `${file}.3f1c2a9e-0000-4000-8000-000000000000.tmp`;
    for (const name of [orphan, live, legacy]) await writeFile(join(folder, name), 'x');
    await ensureProfileFiles(dir);
    expect((await readdir(folder)).sort()).toEqual([file, legacy, live].sort());
  });
});
