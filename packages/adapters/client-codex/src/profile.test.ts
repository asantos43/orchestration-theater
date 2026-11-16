// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidInput } from '@otheater/core';
import {
  CONFIG_FILE,
  renderConfigToml,
  writeProfileConfig,
  type ProfileConfig,
} from './profile.js';

const config: ProfileConfig = {
  credentialsStore: 'file',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
};

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-codex-profile-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('renderConfigToml', () => {
  it('writes three string keys and nothing that looks like a secret', () => {
    const toml = renderConfigToml(config);
    expect(toml).toContain('cli_auth_credentials_store = "file"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).not.toMatch(/token|key|secret|password/i);
  });
});

describe('writeProfileConfig', () => {
  it('creates the directory and writes only config.toml', async () => {
    const root = await tempDir();
    const dir = join(root, 'profiles', 'codex', 'work');
    await writeProfileConfig(dir, config);
    expect(await readdir(dir)).toEqual([CONFIG_FILE]);
    expect(await readFile(join(dir, CONFIG_FILE), 'utf8')).toBe(renderConfigToml(config));
  });

  it('leaves the files of the client, credentials included, as they were', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'client-state.bin'), 'placeholder for a file of the client');
    await writeFile(join(dir, 'history.jsonl'), '{}\n');
    await writeProfileConfig(dir, config);
    expect((await readdir(dir)).sort()).toEqual(['client-state.bin', CONFIG_FILE, 'history.jsonl']);
    expect(await readFile(join(dir, 'client-state.bin'), 'utf8')).toBe(
      'placeholder for a file of the client',
    );
    expect(await readFile(join(dir, 'history.jsonl'), 'utf8')).toBe('{}\n');
  });

  it('replaces an old config.toml and is idempotent, leaving no temporary file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, CONFIG_FILE), 'sandbox_mode = "danger-full-access"\n');
    await writeProfileConfig(dir, config);
    await writeProfileConfig(dir, config);
    expect(await readFile(join(dir, CONFIG_FILE), 'utf8')).toBe(renderConfigToml(config));
    expect(await readdir(dir)).toEqual([CONFIG_FILE]);
  });

  it('refuses a relative directory', async () => {
    await expect(writeProfileConfig('relative/dir', config)).rejects.toBeInstanceOf(InvalidInput);
  });
});
