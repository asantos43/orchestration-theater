// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-vault-temporaries-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The pid of a process that has already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

describe('writeFileAtomic and the orphan temporaries (N306)', () => {
  it('removes the orphan of a dead pid after the write and keeps the rest', async () => {
    const target = join(dir, 'vault.json');
    const orphan = `.vault.json.${String(deadPid())}.0123456789abcdef.tmp`;
    const live = `.vault.json.${String(process.ppid)}.0123456789abcdef.tmp`;
    const legacy = '.vault.json.0123456789abcdef.tmp';
    const other = `.other.json.${String(deadPid())}.0123456789abcdef.tmp`;
    for (const name of [orphan, live, legacy, other]) await writeFile(join(dir, name), 'x');
    await writeFileAtomic(target, 'secret-free text');
    expect(await readFile(target, 'utf8')).toBe('secret-free text');
    expect((await readdir(dir)).sort()).toEqual(['vault.json', legacy, live, other].sort());
  });

  it('leaves no temporary of its own behind', async () => {
    const target = join(dir, 'vault.json');
    await writeFileAtomic(target, 'one');
    await writeFileAtomic(target, 'two');
    expect(await readdir(dir)).toEqual(['vault.json']);
  });
});
