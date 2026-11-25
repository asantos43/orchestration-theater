// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, writeProfileConfig, type ProfileConfig } from './profile.js';

const config: ProfileConfig = {
  credentialsStore: 'file',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-codex-temporaries-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The pid of a process that has already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

describe('writeProfileConfig and the orphan temporaries (N306)', () => {
  it('removes the orphan of a dead pid, also when the file needs no write, and keeps the rest', async () => {
    await writeProfileConfig(dir, config);
    const gone = deadPid();
    const orphan = `${CONFIG_FILE}.${String(gone)}.0123456789ab.tmp`;
    const live = `${CONFIG_FILE}.${String(process.ppid)}.0123456789ab.tmp`;
    const legacy = `${CONFIG_FILE}.0123456789ab.tmp`;
    for (const name of [orphan, live, legacy, 'other.toml']) await writeFile(join(dir, name), 'x');
    await writeProfileConfig(dir, config);
    expect((await readdir(dir)).sort()).toEqual([CONFIG_FILE, legacy, live, 'other.toml'].sort());
  });

  it('names its temporary with its pid and leaves none behind', async () => {
    await writeProfileConfig(dir, config);
    await writeProfileConfig(dir, { ...config, credentialsStore: 'keyring' });
    expect(await readdir(dir)).toEqual([CONFIG_FILE]);
  });

  it('removes a name of before N306, without a pid, once it is older than max_age (1h)', async () => {
    await writeProfileConfig(dir, config);
    const old = `${CONFIG_FILE}.0123456789ab.tmp`;
    const fresh = `${CONFIG_FILE}.ba9876543210.tmp`;
    for (const name of [old, fresh]) await writeFile(join(dir, name), 'x');
    const then = new Date(Date.now() - 2 * 3_600_000);
    await utimes(join(dir, old), then, then);
    await writeProfileConfig(dir, config);
    expect((await readdir(dir)).sort()).toEqual([CONFIG_FILE, fresh].sort());
  });
});
