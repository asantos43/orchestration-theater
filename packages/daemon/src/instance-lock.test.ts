// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Conflict } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { InstanceLock, readLockInfo } from './instance-lock.js';
import { makeTempDataDir } from './test-helpers.js';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('InstanceLock', () => {
  it('refuses a second acquire in the same process and works again after release', async () => {
    const { dir, dispose } = await makeTempDataDir();
    const lockPath = join(dir, 'daemon.lock');
    const infoPath = join(dir, 'daemon.lock.json');
    try {
      const first = await InstanceLock.acquire(lockPath, infoPath);
      await first.publish({ pid: process.pid, startedAt: 1_700_000_000_000, version: '9.9.9' });
      const refused = await InstanceLock.acquire(lockPath, infoPath).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Conflict);
      expect((refused as Error).message).toContain(`pid ${String(process.pid)}`);
      expect((refused as Error).message).toContain('2023-11-14');
      expect(first.held).toBe(true);

      await first.release();
      await first.release(); // idempotent
      expect(first.held).toBe(false);
      expect(await exists(infoPath)).toBe(false);

      const second = await InstanceLock.acquire(lockPath, infoPath);
      await second.release();
    } finally {
      await dispose();
    }
  });

  it('says so when the holder left no info', async () => {
    const { dir, dispose } = await makeTempDataDir();
    try {
      const lock = await InstanceLock.acquire(join(dir, 'l'), join(dir, 'l.json'));
      await expect(InstanceLock.acquire(join(dir, 'l'), join(dir, 'l.json'))).rejects.toThrow(
        /another process holds/,
      );
      await lock.release();
    } finally {
      await dispose();
    }
  });

  it('removes an info file left by a dead process when it wins the lock', async () => {
    const { dir, dispose } = await makeTempDataDir();
    const infoPath = join(dir, 'l.json');
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(infoPath, JSON.stringify({ pid: 1, startedAt: 0, version: 'old' }));
      const lock = await InstanceLock.acquire(join(dir, 'l'), infoPath);
      expect(await readLockInfo(infoPath)).toBeUndefined();
      await lock.release();
    } finally {
      await dispose();
    }
  });

  it('is released by the system when the holder is killed with SIGKILL', async () => {
    const { dir, dispose } = await makeTempDataDir();
    const lockPath = join(dir, 'daemon.lock');
    const infoPath = join(dir, 'daemon.lock.json');
    // A short script: it takes the lock, says so on stdout and waits (at most 20 s).
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked\\n');
      setTimeout(() => process.exit(0), 20000);
    `;
    const child = spawn(process.execPath, ['-e', script, lockPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('the child did not take the lock in time'));
        }, 10_000);
        child.stdout.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
        child.once('error', reject);
      });
      // Held by another process: refused.
      await expect(InstanceLock.acquire(lockPath, infoPath)).rejects.toBeInstanceOf(Conflict);

      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
      });
      child.kill('SIGKILL');
      await exited;

      const lock = await InstanceLock.acquire(lockPath, infoPath);
      await lock.release();
    } finally {
      child.kill('SIGKILL');
      await dispose();
    }
  });

  it('publishes the holder info as JSON beside the lock', async () => {
    const { dir, dispose } = await makeTempDataDir();
    try {
      const infoPath = join(dir, 'l.json');
      const lock = await InstanceLock.acquire(join(dir, 'l'), infoPath);
      await lock.publish({ pid: 7, startedAt: 5, version: '1.2.3' });
      expect(JSON.parse(await readFile(infoPath, 'utf8'))).toEqual({
        pid: 7,
        startedAt: 5,
        version: '1.2.3',
      });
      await lock.release();
    } finally {
      await dispose();
    }
  });
});
