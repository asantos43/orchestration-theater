// SPDX-License-Identifier: MPL-2.0
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Secret } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { makeTempDataDir } from './test-helpers.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('stamps lines with the injected clock, not the system time', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({
      level: 'info',
      destination: 'file',
      logFile: '/unused',
      clock: new FakeClock(1_234_567),
      stream,
    });
    logger.info({ a: 1 }, 'hello');
    expect(lines()).toMatchObject([{ time: 1_234_567, msg: 'hello', a: 1 }]);
  });

  it('never writes a Secret in clear, whatever the key is called', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({
      level: 'info',
      destination: 'file',
      logFile: '/unused',
      clock: new FakeClock(0),
      stream,
    });
    logger.info({ innocent: new Secret('hunter2-in-clear') }, 'with a secret');
    logger.info({ password: 'hunter2-in-clear', nested: { token: 'hunter2-in-clear' } }, 'by key');
    const text = JSON.stringify(lines());
    expect(text).not.toContain('hunter2-in-clear');
    expect(text).toContain('[REDACTED]');
  });

  it('masks the token, the cookies and the Authorization header inside error and request objects', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({
      level: 'info',
      destination: 'file',
      logFile: '/unused',
      clock: new FakeClock(0),
      stream,
    });
    logger.info(
      {
        headers: {
          authorization: 'Bearer leak-1',
          cookie: 'sid=leak-2',
          'set-cookie': ['sid=leak-3'],
        },
        err: { message: 'failed', token: 'leak-4', headers: { Authorization: 'Bearer leak-5' } },
        request: { headers: { authorization: 'Bearer leak-6', cookie: 'sid=leak-7' } },
        error: { response: { headers: { 'set-cookie': ['sid=leak-8'] }, accessToken: 'leak-9' } },
        cookies: { sid: 'leak-10' },
      },
      'objects',
    );
    const text = JSON.stringify(lines());
    expect(text).not.toMatch(/leak-\d/);
    expect(text).toContain('failed');
  });

  it('honours the level', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({
      level: 'warn',
      destination: 'file',
      logFile: '/unused',
      clock: new FakeClock(0),
      stream,
    });
    logger.info('quiet');
    logger.warn('loud');
    expect(lines().map((line) => line.msg)).toEqual(['loud']);
  });

  it.skipIf(process.platform === 'win32')(
    'writes the file with mode 0600, creating its folder, and close() is idempotent',
    async () => {
      const tmp = await makeTempDataDir();
      try {
        const logFile = join(tmp.dir, 'logs', 'daemon.log');
        const created = createLogger({
          level: 'info',
          destination: 'file',
          logFile,
          clock: new FakeClock(5),
        });
        created.logger.info('to the file');
        created.close();
        created.close();
        expect((await stat(logFile)).mode & 0o777).toBe(0o600);
        expect(await readFile(logFile, 'utf8')).toContain('"msg":"to the file"');
      } finally {
        await tmp.dispose();
      }
    },
  );
});
