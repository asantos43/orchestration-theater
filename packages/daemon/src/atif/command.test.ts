// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { AtifTrajectorySchema } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { publishDiscovery } from '../api/files.js';
import { main, type CliDeps } from '../cli.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';

/** The CLI of the export (P5, N219): `ot trajectory export <play>`, with the daemon stopped and running. */

const SECRET = 'cli-planted-secret-4d81c0e7';

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

async function ot(
  argv: readonly string[],
  home: string,
  extra: Partial<CliDeps> = {},
): Promise<Captured & { code: number }> {
  const captured: Captured = { out: [], err: [] };
  const code = await main(argv, {
    env: {},
    platform: 'linux',
    homedir: home,
    out: (line) => captured.out.push(line),
    err: (line) => captured.err.push(line),
    systemLocale: 'en',
    version: '1.2.3',
    ...extra,
  });
  return { ...captured, code };
}

/** A store with one play whose need holds a secret of the vault. */
async function seeded(): Promise<{
  overrides: NonNullable<CliDeps['overrides']>;
  store: Store;
}> {
  const clock = new FakeClock(Date.UTC(2026, 10, 21, 15, 0, 0));
  const store = new InMemoryStore({ clock });
  const vault = new InMemorySecretVault();
  await vault.set('profiles/planted/api_key', new (await import('@otheater/core')).Secret(SECRET));
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'software',
    name: 'Scenario',
    folder: '/tmp/none',
    profile: 'software',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: `Write it with key ${SECRET}`,
    flowId: 'software',
    flowVersion: 1,
    state: 'DONE',
  });
  return { overrides: { clock, store, vault }, store };
}

describe('ot trajectory export (P5, N219)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((done) => {
            server.close(() => {
              done(undefined);
            });
          }),
      ),
    );
  });

  it('with the daemon stopped, writes the file of the play to atif.export.dir and says so', async () => {
    const tmp = await makeTempDataDir();
    try {
      const { overrides } = await seeded();
      const result = await ot(['trajectory', 'export', 'p1', '--data-dir', tmp.dir], tmp.dir, {
        overrides,
        passwordPrompt: undefined,
      });
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
      const file = join(tmp.dir, 'trajectories', 'p1.atif.json');
      expect(result.out.join('\n')).toContain(file);
      const text = await readFile(file, 'utf8');
      expect(AtifTrajectorySchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(text).not.toContain(SECRET);
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await tmp.dispose();
    }
  });

  it('--unit, --content and --out replace the config; relative --out is relative to the folder of the call', async () => {
    const tmp = await makeTempDataDir();
    try {
      const { overrides } = await seeded();
      const redacted = await ot(
        [
          'trajectory',
          'export',
          'p1',
          '--unit',
          'attempt',
          '--content',
          'redacted',
          '--out',
          'here',
          '--data-dir',
          tmp.dir,
        ],
        tmp.dir,
        { overrides, cwd: tmp.dir },
      );
      expect(redacted.code).toBe(0);
      // no attempt in this play: no file for the unit attempt, and no failure either
      expect(redacted.err).toEqual([]);
      const files = await readdir(join(tmp.dir, 'here')).catch(() => []);
      expect(files.filter((name) => name.endsWith('.atif.json'))).toEqual([]);

      // a composition closes its store: the next call gets a new one
      const flat = await ot(
        [
          'trajectory',
          'export',
          'p1',
          '--content',
          'redacted',
          '--out',
          'there',
          '--data-dir',
          tmp.dir,
        ],
        tmp.dir,
        { overrides: (await seeded()).overrides, cwd: tmp.dir },
      );
      expect(flat.code).toBe(0);
      const text = await readFile(join(tmp.dir, 'there', 'p1.atif.json'), 'utf8');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('Write it with key');
    } finally {
      await tmp.dispose();
    }
  });

  it('writes nothing and exits 1 for an unknown play, in pt-BR when asked', async () => {
    const tmp = await makeTempDataDir();
    try {
      const { overrides } = await seeded();
      const result = await ot(['trajectory', 'export', 'nope', '--data-dir', tmp.dir], tmp.dir, {
        overrides,
        systemLocale: 'pt-BR',
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toMatch(/nope/);
      expect(result.out).toEqual([]);
      expect(await readdir(tmp.dir)).not.toContain('trajectories');
    } finally {
      await tmp.dispose();
    }
  });

  it.each([
    ['no action', ['trajectory'], /Missing action for "ot trajectory"/],
    ['an unknown action', ['trajectory', 'burn'], /Unknown action for "ot trajectory": burn/],
    ['no play', ['trajectory', 'export'], /needs the id of a play/],
    ['two plays', ['trajectory', 'export', 'a', 'b'], /takes only one play/],
    ['a bad unit', ['trajectory', 'export', 'a', '--unit', 'all'], /--unit must be one of/],
    ['a bad content', ['trajectory', 'export', 'a', '--content', 'x'], /--content must be one of/],
  ])('exits 2 with a hint for %s', async (_name, argv, message) => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot([...argv, '--data-dir', tmp.dir], tmp.dir);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(message);
      expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
      expect(result.out).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('lists the command in the help of both languages', async () => {
    const tmp = await makeTempDataDir();
    try {
      const en = await ot(['--help', '--data-dir', tmp.dir], tmp.dir);
      expect(en.out.join('\n')).toContain('trajectory export <play>');
      const pt = await ot(['--help', '--data-dir', tmp.dir], tmp.dir, { systemLocale: 'pt-BR' });
      expect(pt.out.join('\n')).toContain('trajectory export <peça>');
    } finally {
      await tmp.dispose();
    }
  });

  describe('with the daemon running', () => {
    async function withDaemon(
      tmpDir: string,
      respond: (
        url: string,
        authorization: string | undefined,
      ) => { status: number; body: unknown },
    ): Promise<{ requests: string[]; release: () => Promise<void> }> {
      const paths = dataPaths(tmpDir);
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
        const { status, body } = respond(request.url ?? '', request.headers.authorization);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      servers.push(server);
      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
      const { port } = server.address() as AddressInfo;
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      await mkdir(paths.dataDir, { recursive: true });
      await publishDiscovery(paths.apiDiscovery, {
        url: `http://127.0.0.1:${String(port)}`,
        daemonId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        pid: process.pid,
        apiVersion: 1,
      });
      await writeFile(paths.apiToken, 'token-of-the-test-0123456789abcdefghijklmnop\n');
      return { requests, release: () => lock.release() };
    }

    it('asks the route with the token and writes the file locally', async () => {
      const tmp = await makeTempDataDir();
      try {
        const { overrides } = await seeded();
        // The trajectory the daemon would answer: the same exporter on a store of the test.
        const offline = await makeTempDataDir();
        let trajectory: unknown;
        try {
          await ot(['trajectory', 'export', 'p1', '--data-dir', offline.dir], offline.dir, {
            overrides,
          });
          trajectory = JSON.parse(
            await readFile(join(offline.dir, 'trajectories', 'p1.atif.json'), 'utf8'),
          );
        } finally {
          await offline.dispose();
        }
        const daemon = await withDaemon(tmp.dir, (_url, authorization) =>
          authorization === 'Bearer token-of-the-test-0123456789abcdefghijklmnop'
            ? { status: 200, body: trajectory }
            : { status: 401, body: {} },
        );
        try {
          const result = await ot(
            ['trajectory', 'export', 'p1', '--content', 'redacted', '--data-dir', tmp.dir],
            tmp.dir,
          );
          expect(result.err).toEqual([]);
          expect(result.code).toBe(0);
          expect(daemon.requests).toEqual(['GET /v1/plays/p1/atif?content=redacted']);
          const file = join(tmp.dir, 'trajectories', 'p1.atif.json');
          expect(result.out.join('\n')).toContain(file);
          expect(
            AtifTrajectorySchema.safeParse(JSON.parse(await readFile(file, 'utf8'))).success,
          ).toBe(true);
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });

    it('says what went wrong: 404, a rejected token, the units that need a stopped daemon', async () => {
      const tmp = await makeTempDataDir();
      try {
        let status = 404;
        const daemon = await withDaemon(tmp.dir, () => ({ status, body: {} }));
        try {
          const missing = await ot(
            ['trajectory', 'export', 'nope', '--data-dir', tmp.dir],
            tmp.dir,
          );
          expect(missing.code).toBe(1);
          expect(missing.err.join('\n')).toMatch(/There is no play "nope"/);
          status = 401;
          const rejected = await ot(['trajectory', 'export', 'p1', '--data-dir', tmp.dir], tmp.dir);
          expect(rejected.code).toBe(1);
          status = 500;
          const broken = await ot(['trajectory', 'export', 'p1', '--data-dir', tmp.dir], tmp.dir);
          expect(broken.code).toBe(1);
          expect(broken.err.join('\n')).toMatch(/HTTP 500/);
          const files = await ot(
            ['trajectory', 'export', 'p1', '--unit', 'play_files', '--data-dir', tmp.dir],
            tmp.dir,
          );
          expect(files.code).toBe(1);
          expect(files.err.join('\n')).toMatch(/Stop the daemon/);
          expect(await readdir(tmp.dir)).not.toContain('trajectories');
          expect(daemon.requests).toHaveLength(3);
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });

    it('fails with the api-token missing', async () => {
      const tmp = await makeTempDataDir();
      try {
        const daemon = await withDaemon(tmp.dir, () => ({ status: 200, body: {} }));
        try {
          await rm(dataPaths(tmp.dir).apiToken);
          const result = await ot(['trajectory', 'export', 'p1', '--data-dir', tmp.dir], tmp.dir);
          expect(result.code).toBe(1);
          expect(result.err.join('\n')).toMatch(/api-token/);
          expect(daemon.requests).toEqual([]);
        } finally {
          await daemon.release();
        }
      } finally {
        await tmp.dispose();
      }
    });
  });
});
