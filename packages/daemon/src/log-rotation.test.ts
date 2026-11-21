// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { RotatingFile, rotateChain } from './log-rotation.js';
import { makeTempDataDir } from './test-helpers.js';

/** A line of exactly `n` bytes, with its newline. */
const line = (tag: string, n = 10): string => `${tag.padEnd(n - 1, '.')}\n`;

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  try {
    await run(tmp.dir);
  } finally {
    await tmp.dispose();
  }
}

const names = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe('RotatingFile', () => {
  it('rotates when a line would pass the size, newest copy first', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 30, keep: 3 });
      for (const tag of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) file.write(line(tag));
      file.end();
      // Three lines per file: [a b c] [d e f] [g].
      expect(await names(dir)).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
      expect(await readFile(path, 'utf8')).toBe(line('g'));
      expect(await readFile(`${path}.1`, 'utf8')).toBe(line('d') + line('e') + line('f'));
      expect(await readFile(`${path}.2`, 'utf8')).toBe(line('a') + line('b') + line('c'));
    });
  });

  it('keeps only `keep` copies and drops the oldest', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 20, keep: 2 });
      for (let i = 0; i < 20; i += 1) file.write(line(String(i).padStart(2, '0')));
      file.end();
      expect(await names(dir)).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
      // 20 lines, two per file: the file holds 18-19, the copies 16-17 and 14-15.
      expect(await readFile(path, 'utf8')).toBe(line('18') + line('19'));
      expect(await readFile(`${path}.1`, 'utf8')).toBe(line('16') + line('17'));
      expect(await readFile(`${path}.2`, 'utf8')).toBe(line('14') + line('15'));
    });
  });

  it('keep 0 keeps no copy', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 20, keep: 0 });
      for (const tag of ['a', 'b', 'c', 'd', 'e']) file.write(line(tag));
      file.end();
      expect(await names(dir)).toEqual(['daemon.log']);
      expect(await readFile(path, 'utf8')).toBe(line('e'));
    });
  });

  it('goes on in the file that was there, appending to what it held', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      await writeFile(path, line('old'));
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 100, keep: 1 });
      file.write(line('new'));
      file.end();
      expect(await readFile(path, 'utf8')).toBe(line('old') + line('new'));
    });
  });

  it('a line longer than the size is written whole, in a file of its own', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 10, keep: 2 });
      file.write(line('a'));
      file.write(line('big', 50));
      file.write(line('b'));
      file.end();
      expect(await readFile(path, 'utf8')).toBe(line('b'));
      expect(await readFile(`${path}.1`, 'utf8')).toBe(line('big', 50));
      expect(await readFile(`${path}.2`, 'utf8')).toBe(line('a'));
    });
  });

  it('a rotation that fails keeps logging, tells each failure and waits for more log to try again', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      // A folder with something in it is where the copy would go: it cannot be removed or replaced.
      await mkdir(join(`${path}.1`, 'inside'), { recursive: true });
      const errors: unknown[] = [];
      const file = new RotatingFile({
        path,
        mode: 0o600,
        maxBytes: 20,
        keep: 1,
        onError: (error) => errors.push(error),
      });
      for (const tag of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) file.write(line(tag));
      // Tries at the third line, then only after another 20 bytes: the fifth and the seventh, not
      // at every line.
      expect(errors).toHaveLength(3);
      file.end();
      expect(await readFile(path, 'utf8')).toBe(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((tag) => line(tag)).join(''),
      );
    });
  });

  it('never throws into the logger when the report or the write fails', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      await mkdir(join(`${path}.1`, 'inside'), { recursive: true });
      const file = new RotatingFile({
        path,
        mode: 0o600,
        maxBytes: 10,
        keep: 1,
        onError: () => {
          throw new Error('the report broke');
        },
      });
      expect(() => {
        file.write(line('a'));
        file.write(line('b'));
        file.end();
        file.write(line('after the end'));
      }).not.toThrow();
    });
  });

  it('opens the file again after a rotation that removed it', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      const file = new RotatingFile({ path, mode: 0o600, maxBytes: 10, keep: 0 });
      file.write(line('a'));
      file.write(line('b'));
      file.end();
      expect(await readFile(path, 'utf8')).toBe(line('b'));
    });
  });
});

describe('rotateChain', () => {
  it('skips the names that are free', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'daemon.log');
      await writeFile(path, 'now');
      await writeFile(`${path}.2`, 'older');
      rotateChain(path, 4);
      expect(await names(dir)).toEqual(['daemon.log.1', 'daemon.log.3']);
      expect(await readFile(`${path}.1`, 'utf8')).toBe('now');
      expect(await readFile(`${path}.3`, 'utf8')).toBe('older');
    });
  });

  it('does nothing when there is no file', async () => {
    await withDir(async (dir) => {
      expect(() => {
        rotateChain(join(dir, 'daemon.log'), 3);
        rotateChain(join(dir, 'daemon.log'), 0);
      }).not.toThrow();
      expect(await names(dir)).toEqual([]);
    });
  });
});

describe('createLogger with rotate', () => {
  it('rotates daemon.log by size and keeps the copies the key asks for', async () => {
    await withDir(async (dir) => {
      const logFile = join(dir, 'logs', 'daemon.log');
      const created = createLogger({
        level: 'info',
        destination: 'file',
        logFile,
        clock: new FakeClock(7),
        rotate: { maxBytes: 300, keep: 2 },
      });
      for (let i = 0; i < 40; i += 1) created.logger.info({ i }, 'a line of the log');
      created.close();
      expect(await names(join(dir, 'logs'))).toEqual([
        'daemon.log',
        'daemon.log.1',
        'daemon.log.2',
      ]);
      for (const name of ['daemon.log', 'daemon.log.1', 'daemon.log.2']) {
        const text = await readFile(join(dir, 'logs', name), 'utf8');
        expect(text.length).toBeLessThanOrEqual(300);
        // Every copy holds whole lines.
        for (const each of text.split('\n').filter((l) => l !== '')) {
          expect(JSON.parse(each)).toMatchObject({ msg: 'a line of the log' });
        }
      }
      // The newest line is in the file; what is gone is the oldest.
      expect(await readFile(logFile, 'utf8')).toContain('"i":39');
      const all = ['', '.1', '.2'].map((suffix) => readFile(`${logFile}${suffix}`, 'utf8'));
      expect((await Promise.all(all)).join('')).not.toContain('"i":0,');
    });
  });

  it.skipIf(process.platform === 'win32')('keeps the mode 0600 across a rotation', async () => {
    await withDir(async (dir) => {
      const logFile = join(dir, 'logs', 'daemon.log');
      const created = createLogger({
        level: 'info',
        destination: 'file',
        logFile,
        clock: new FakeClock(7),
        rotate: { maxBytes: 100, keep: 1 },
      });
      for (let i = 0; i < 5; i += 1) created.logger.info({ i }, 'a line of the log');
      created.close();
      const { stat } = await import('node:fs/promises');
      expect((await stat(logFile)).mode & 0o777).toBe(0o600);
      expect((await stat(`${logFile}.1`)).mode & 0o777).toBe(0o600);
    });
  });

  it('without rotate the file only grows', async () => {
    await withDir(async (dir) => {
      const logFile = join(dir, 'logs', 'daemon.log');
      const created = createLogger({
        level: 'info',
        destination: 'file',
        logFile,
        clock: new FakeClock(7),
      });
      for (let i = 0; i < 20; i += 1) created.logger.info({ i }, 'a line of the log');
      created.close();
      expect(await names(join(dir, 'logs'))).toEqual(['daemon.log']);
    });
  });
});
