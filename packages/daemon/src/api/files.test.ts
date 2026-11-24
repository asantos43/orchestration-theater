// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  sweepApiTemporaries,
  sweepOrphanTemporaries,
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

describe('orphan temporaries of a killed writer (N306)', () => {
  const DEAD = 2_000_000_000;
  const hex = '0123456789abcdef';
  const dead = (pid: number): boolean => pid !== 4242;

  it('removes the temporary of a dead pid and leaves the file itself', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon-id');
      await writeFile(path, 'the id');
      await writeFile(`${path}.${String(DEAD)}.${hex}.tmp`, 'half');
      const removed = await sweepOrphanTemporaries(path, { alive: () => false });
      expect(removed).toEqual([`daemon-id.${String(DEAD)}.${hex}.tmp`]);
      expect(await readdir(dir)).toEqual(['daemon-id']);
    });
  });

  it('with the real check of the pid, a process that ended is dead and this one is alive', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon-id');
      const gone = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
      const orphan = `daemon-id.${String(gone)}.${hex}.tmp`;
      const live = `daemon-id.${String(process.ppid)}.${hex}.tmp`;
      await writeFile(join(dir, orphan), 'half');
      await writeFile(join(dir, live), 'in flight');
      expect(await sweepOrphanTemporaries(path)).toEqual([orphan]);
      expect(await readdir(dir)).toEqual([live]);
    });
  });

  it('leaves the temporary of a live pid, and its own pid unless told otherwise', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api-token');
      const live = `api-token.4242.${hex}.tmp`;
      const own = `api-token.${String(process.pid)}.${hex}.tmp`;
      await writeFile(join(dir, live), 'in flight');
      await writeFile(join(dir, own), 'mine');
      expect(await sweepOrphanTemporaries(path, { alive: (pid) => pid === 4242 })).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual([live, own].sort());
      // At start-up its own pid is a left-over of an earlier process; the live one stays.
      expect(
        await sweepOrphanTemporaries(path, { alive: (pid) => pid === 4242, includeOwnPid: true }),
      ).toEqual([own]);
      expect(await readdir(dir)).toEqual([live]);
    });
  });

  it('never touches a name outside the pattern or a temporary of another file', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'api.json');
      const keep = [
        `api.json.${String(DEAD)}.tmp`, // no random part
        `api.json.${String(DEAD)}.${hex}`, // not .tmp
        `api.json.${String(DEAD)}.${hex}.tmp.old`,
        `api.json.${String(DEAD)}.XYZXYZXYZXYZXYZX.tmp`,
        `api.json.abc.${hex}.tmp`, // the pid is not a number
        `api.json.0.${hex}.tmp`, // pid 0 is no process
        `api-json.${String(DEAD)}.${hex}.tmp`,
        `other.${String(DEAD)}.${hex}.tmp`, // another file's
        `xapi.json.${String(DEAD)}.${hex}.tmp`,
        'api.json.bak',
        'api.json',
      ];
      for (const name of keep) await writeFile(join(dir, name), 'keep');
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'sub', `api.json.${String(DEAD)}.${hex}.tmp`), 'keep');
      expect(await sweepOrphanTemporaries(path, { alive: dead })).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual([...keep, 'sub'].sort());
    });
  });

  it('is quiet about a folder that is not there', async () => {
    await withDir(async (dir) => {
      const onError = vi.fn();
      expect(await sweepOrphanTemporaries(join(dir, 'gone', 'daemon-id'), { onError })).toEqual([]);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('sweeps the three files of the daemon and says what it removed', async () => {
    await withDir(async (dir) => {
      for (const name of ['daemon-id', 'api-token', 'api.json']) {
        await writeFile(join(dir, `${name}.${String(DEAD)}.${hex}.tmp`), 'half');
      }
      const info = vi.fn();
      const removed = await sweepApiTemporaries(
        ['daemon-id', 'api-token', 'api.json'].map((name) => join(dir, name)),
        { logger: { info, warn: vi.fn() } as never, alive: () => false },
      );
      expect(removed).toHaveLength(3);
      expect(await readdir(dir)).toEqual([]);
      expect(info).toHaveBeenCalledOnce();
    });
  });

  it('a removal that fails is a warning and a daemon.notice, and the start goes on', async () => {
    await withDir(async (dir) => {
      const stuck = `daemon-id.${String(DEAD)}.${hex}.tmp`;
      // A folder with the name of a temporary: `rm` without `recursive` refuses it.
      await mkdir(join(dir, stuck));
      const warn = vi.fn();
      const record = vi.fn();
      const removed = await sweepApiTemporaries([join(dir, 'daemon-id')], {
        logger: { info: vi.fn(), warn } as never,
        situations: { record },
        alive: () => false,
      });
      expect(removed).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledWith('daemon.notice', {
        kind: 'temporary_cleanup_failed',
        subject: stuck,
        detail: expect.any(String) as string,
      });
      // The daemon still comes up: the id is made and written.
      const id = await loadOrCreateDaemonId(join(dir, 'daemon-id'));
      expect(id).toMatch(UUID);
    });
  });
});
