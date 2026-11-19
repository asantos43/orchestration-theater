// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ISOLATION,
  DEFAULT_PROFILE_CONFIG,
  ensureProfileFiles,
  isolationEnv,
  profileLayout,
} from './profile.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otheater-opencode-profile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isolationEnv', () => {
  it('points the XDG homes and the database into the profile', () => {
    const layout = profileLayout(dir);
    expect(isolationEnv(dir)).toEqual({
      XDG_DATA_HOME: layout.homes.data,
      XDG_CONFIG_HOME: layout.homes.config,
      XDG_STATE_HOME: layout.homes.state,
      OPENCODE_DB: layout.db,
    });
    expect(DEFAULT_ISOLATION).toEqual(['data', 'config', 'state']);
  });

  it('isolates only the homes it is asked to, but always the database', () => {
    expect(Object.keys(isolationEnv(dir, ['data']))).toEqual(['XDG_DATA_HOME', 'OPENCODE_DB']);
    expect(Object.keys(isolationEnv(dir, ['state', 'cache'])).sort()).toEqual([
      'OPENCODE_DB',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
    ]);
  });

  it('refuses a profile directory that is not absolute', () => {
    expect(() => isolationEnv('relative/dir')).toThrow(InvalidInput);
    expect(() => profileLayout('')).toThrow(InvalidInput);
  });
});

describe('ensureProfileFiles', () => {
  it('makes the directories and writes the opencode.json of the profile', async () => {
    await ensureProfileFiles(dir);
    const layout = profileLayout(dir);
    for (const path of [layout.homes.data, layout.homes.config, layout.dbDir]) {
      expect((await stat(path)).isDirectory()).toBe(true);
    }
    expect(JSON.parse(await readFile(layout.configFile, 'utf8'))).toEqual(DEFAULT_PROFILE_CONFIG);
  });

  it('puts nothing inside the data directory: the login of the client is not ours', async () => {
    await ensureProfileFiles(dir);
    expect(await readdir(profileLayout(dir).homes.data)).toEqual([]);
  });

  it('is idempotent and leaves no temporary file behind', async () => {
    await ensureProfileFiles(dir);
    await ensureProfileFiles(dir);
    const files = await readdir(join(profileLayout(dir).homes.config, 'opencode'));
    expect(files).toEqual(['opencode.json']);
  });

  it('takes several calls on one profile at once, and leaves no temporary file behind', async () => {
    // A logout and a probe of one profile run together; on Windows the rename of one met the other.
    await Promise.all(Array.from({ length: 8 }, () => ensureProfileFiles(dir)));
    const files = await readdir(join(profileLayout(dir).homes.config, 'opencode'));
    expect(files).toEqual(['opencode.json']);
    expect(JSON.parse(await readFile(profileLayout(dir).configFile, 'utf8'))).toEqual(
      DEFAULT_PROFILE_CONFIG,
    );
  });

  it('rewrites a config that differs, and writes none with `null`', async () => {
    await ensureProfileFiles(dir, { profileConfig: { autoupdate: true } });
    expect(JSON.parse(await readFile(profileLayout(dir).configFile, 'utf8'))).toEqual({
      autoupdate: true,
    });
    await ensureProfileFiles(dir);
    expect(JSON.parse(await readFile(profileLayout(dir).configFile, 'utf8'))).toEqual(
      DEFAULT_PROFILE_CONFIG,
    );
    const other = await mkdtemp(join(tmpdir(), 'otheater-opencode-profile-'));
    try {
      await ensureProfileFiles(other, { profileConfig: null });
      await expect(readFile(profileLayout(other).configFile)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('writes no config when the config home is not isolated', async () => {
    await ensureProfileFiles(dir, { isolation: ['data'] });
    await expect(stat(profileLayout(dir).homes.config)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('survives two writers at once', async () => {
    await Promise.all([ensureProfileFiles(dir), ensureProfileFiles(dir), ensureProfileFiles(dir)]);
    expect(JSON.parse(await readFile(profileLayout(dir).configFile, 'utf8'))).toEqual(
      DEFAULT_PROFILE_CONFIG,
    );
  });
});
