// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import {
  generateApiToken,
  isProcessAlive,
  loadOrCreateApiToken,
  loadOrCreateDaemonId,
  publishDiscovery,
  readApiToken,
  readDaemonId,
  readDiscovery,
  removeDiscovery,
  sameToken,
  writePrivateFile,
} from './files.js';

const WINDOWS = process.platform === 'win32';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  try {
    await run(tmp.dir);
  } finally {
    await tmp.dispose();
  }
}

describe('generateApiToken', () => {
  it('makes 32 random bytes in base64url, different each time', () => {
    const a = generateApiToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateApiToken()).not.toBe(a);
  });
});

describe('writePrivateFile', () => {
  it('writes atomically with mode 0600, leaving no temporary file', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'secret');
      await writePrivateFile(path, 'one');
      await writePrivateFile(path, 'two');
      expect(await readFile(path, 'utf8')).toBe('two');
      if (!WINDOWS) expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(['secret']);
    });
  });
});

describe('daemon-id', () => {
  it('is a UUID made on the first start and kept afterwards', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon-id');
      expect(await readDaemonId(path)).toBeUndefined();
      const first = await loadOrCreateDaemonId(path);
      expect(first).toMatch(UUID);
      expect(await loadOrCreateDaemonId(path)).toBe(first);
      expect(await readDaemonId(path)).toBe(first);
      if (!WINDOWS) expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  it('replaces a damaged file with a new UUID', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon-id');
      await writeFile(path, 'not a uuid');
      const id = await loadOrCreateDaemonId(path, createSilentLogger());
      expect(id).toMatch(UUID);
      expect(await readDaemonId(path)).toBe(id);
    });
  });
});

describe('api-token', () => {
  it('persistent reuses the token of the file; per_start makes a new one each time', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api-token');
      const first = await loadOrCreateApiToken(path, 'persistent');
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await loadOrCreateApiToken(path, 'persistent')).toBe(first);
      expect(await readApiToken(path)).toBe(first);
      const second = await loadOrCreateApiToken(path, 'per_start');
      expect(second).not.toBe(first);
      expect(await readApiToken(path)).toBe(second);
      expect(await loadOrCreateApiToken(path, 'per_start')).not.toBe(second);
      if (!WINDOWS) expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  it('persistent replaces a file that does not hold a token', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api-token');
      await writeFile(path, 'short\n');
      const token = await loadOrCreateApiToken(path, 'persistent');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  it('readApiToken tolerates a trailing newline and a missing file', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api-token');
      expect(await readApiToken(path)).toBeUndefined();
      const token = generateApiToken();
      await writeFile(path, `${token}\n`);
      expect(await readApiToken(path)).toBe(token);
    });
  });
});

describe('sameToken', () => {
  it('compares the whole token, whatever its length', () => {
    const token = generateApiToken();
    expect(sameToken(token, token)).toBe(true);
    expect(sameToken(`${token}x`, token)).toBe(false);
    expect(sameToken(token.slice(1), token)).toBe(false);
    expect(sameToken('', token)).toBe(false);
    expect(sameToken(undefined, token)).toBe(false);
  });
});

describe('api.json', () => {
  const info = {
    url: 'http://127.0.0.1:4500',
    daemonId: '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11',
    pid: process.pid,
    apiVersion: 1,
  };

  it('is live while its pid is alive and stale when it is gone', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api.json');
      expect((await readDiscovery(path)).kind).toBe('none');
      await publishDiscovery(path, info);
      expect(await readDiscovery(path)).toEqual({ kind: 'live', info });
      expect(await readDiscovery(path, () => false)).toEqual({ kind: 'stale', info });
      if (!WINDOWS) expect((await stat(path)).mode & 0o777).toBe(0o600);
      await removeDiscovery(path);
      expect((await readDiscovery(path)).kind).toBe('none');
      await removeDiscovery(path); // already gone: not an error
    });
  });

  it('is invalid when it is not what the contract describes', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api.json');
      await writeFile(path, '{"url":"nope"}');
      expect((await readDiscovery(path)).kind).toBe('invalid');
      await writeFile(path, 'not json');
      expect((await readDiscovery(path)).kind).toBe('invalid');
    });
  });
});

describe('isProcessAlive', () => {
  it('knows this process and a pid that does not exist', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_000)).toBe(false);
  });
});
