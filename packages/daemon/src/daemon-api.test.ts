// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_VERSION, type ApiStatus } from '@otheater/protocol';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { parseConfig, type DaemonConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { dataPaths } from './paths.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

/** The HTTP API of the daemon, as it starts and stops with it (P3 of docs/17). */

const WINDOWS = process.platform === 'win32';
const AUTO = parseConfig('backup:\n  when: manual\n');
const PER_START = parseConfig('backup:\n  when: manual\napi:\n  token: per_start\n');

function start(
  dataDir: string,
  config: DaemonConfig = AUTO,
  store?: InMemoryStore,
): Promise<DaemonHandle> {
  const clock = new FakeClock();
  return startDaemon({
    dataDir,
    clientSearch: NO_CLIENTS,
    config,
    overrides: {
      clock,
      vault: new InMemorySecretVault(),
      ...(store === undefined ? {} : { store }),
    },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
}

const memoryStore = (): InMemoryStore => new InMemoryStore({ clock: new FakeClock() });

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const tokenOf = async (dir: string): Promise<string> =>
  (await readFile(dataPaths(dir).apiToken, 'utf8')).trim();

function get(url: string, token: string, path = '/v1/status'): Promise<Response> {
  return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function ot(
  dir: string,
  argv: string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', dir], {
    env: {},
    platform: 'linux',
    homedir: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: 'en',
    version: '0.0.0-test',
    overrides: { vault: new InMemorySecretVault() },
  });
  return { code, out, err };
}

/** The pid of a process that ran and is gone. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

describe('startDaemon, the HTTP API', () => {
  it('removes the temporaries a killed daemon left beside its files, and only those (N306)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const hex = '0123456789abcdef';
      const dead = String(deadPid());
      const orphans = [`daemon-id.${dead}.${hex}.tmp`, `api.json.${dead}.${hex}.tmp`];
      const stuck = `api-token.${dead}.${hex}.tmp`;
      const keep = ['notes.tmp', `other.${dead}.${hex}.tmp`, `api.json.${dead}.tmp`];
      for (const name of [...orphans, ...keep]) await writeFile(join(tmp.dir, name), 'x');
      // One that cannot be removed (a folder): a warning and a notice, and the daemon still starts.
      await mkdir(join(tmp.dir, stuck));
      const store = memoryStore();
      const daemon = await start(tmp.dir, AUTO, store);
      expect((await readdir(tmp.dir)).filter((name) => name.includes('.tmp')).sort()).toEqual(
        [...keep, stuck].sort(),
      );
      // The situations are written by a queue; wait for the notice (at most 5 s).
      let notices: Awaited<ReturnType<typeof store.events.readFrom>> = [];
      for (let tries = 0; tries < 100 && notices.length === 0; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        notices = (await store.events.readFrom(0, 200)).filter(
          (event) => event.type === 'daemon.notice',
        );
      }
      expect(notices.map((event) => event.payload)).toContainEqual({
        kind: 'temporary_cleanup_failed',
        subject: stuck,
        detail: expect.any(String) as string,
      });
      await daemon.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });

  it('answers GET /v1/status with the token, publishes api.json and api-token (0600), and records api.started', async () => {
    const tmp = await makeTempDataDir();
    try {
      const store = memoryStore();
      const daemon = await start(tmp.dir, AUTO, store);
      const paths = dataPaths(tmp.dir);
      const token = await tokenOf(tmp.dir);
      expect(daemon.api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const answer = await get(daemon.api.url, token);
      expect(answer.status).toBe(200);
      const status = (await answer.json()) as ApiStatus;
      expect(status).toMatchObject({
        pid: process.pid,
        version: '0.0.0-test',
        state: 'running',
        dataDir: tmp.dir,
        daemonId: daemon.daemonId,
        apiVersion: API_VERSION,
      });
      expect((await fetch(`${daemon.api.url}/v1/status`)).status).toBe(401);

      const discovery = JSON.parse(await readFile(paths.apiDiscovery, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(discovery).toEqual({
        url: daemon.api.url,
        daemonId: daemon.daemonId,
        pid: process.pid,
        apiVersion: API_VERSION,
      });
      if (!WINDOWS) {
        expect((await stat(paths.apiDiscovery)).mode & 0o777).toBe(0o600);
        expect((await stat(paths.apiToken)).mode & 0o777).toBe(0o600);
      }

      const events = await store.events.readFrom(0, 20);
      const started = events.find((event) => event.type === 'api.started');
      expect(started?.payload).toEqual({
        url: daemon.api.url,
        daemonId: daemon.daemonId,
        tokenMode: 'persistent',
      });
      expect(JSON.stringify(events)).not.toContain(token);
      await daemon.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });

  it('removes api.json when it stops, and the server stops answering', async () => {
    const tmp = await makeTempDataDir();
    try {
      const daemon = await start(tmp.dir);
      const { url } = daemon.api;
      const token = await tokenOf(tmp.dir);
      expect(await exists(dataPaths(tmp.dir).apiDiscovery)).toBe(true);
      await daemon.stop('shutdown');
      expect(await exists(dataPaths(tmp.dir).apiDiscovery)).toBe(false);
      await expect(get(url, token)).rejects.toThrow();
      expect(await exists(dataPaths(tmp.dir).apiToken)).toBe(true); // the token stays for the next start
    } finally {
      await tmp.dispose();
    }
  });

  it('keeps the token and the daemon id across restarts with api.token persistent', async () => {
    const tmp = await makeTempDataDir();
    try {
      const first = await start(tmp.dir);
      const token = await tokenOf(tmp.dir);
      const id = first.daemonId;
      await first.stop('shutdown');
      const second = await start(tmp.dir);
      expect(second.daemonId).toBe(id);
      expect(await tokenOf(tmp.dir)).toBe(token);
      expect((await get(second.api.url, token)).status).toBe(200);
      await second.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });

  it('makes a new token at each start with api.token per_start, and keeps the daemon id', async () => {
    const tmp = await makeTempDataDir();
    try {
      const first = await start(tmp.dir, PER_START);
      const token = await tokenOf(tmp.dir);
      await first.stop('shutdown');
      const store = memoryStore();
      const second = await start(tmp.dir, PER_START, store);
      const fresh = await tokenOf(tmp.dir);
      expect(fresh).not.toBe(token);
      expect(second.daemonId).toBe(first.daemonId);
      expect((await get(second.api.url, token)).status).toBe(401);
      expect((await get(second.api.url, fresh)).status).toBe(200);
      const events = await store.events.readFrom(0, 20);
      expect(events.find((event) => event.type === 'api.started')?.payload).toMatchObject({
        tokenMode: 'per_start',
      });
      await second.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });

  it('takes api.port when it is a number, and refuses a start when the port is busy, freeing the lock', async () => {
    const first = await makeTempDataDir();
    const second = await makeTempDataDir();
    try {
      const a = await start(first.dir);
      const port = Number(new URL(a.api.url).port);
      const config = parseConfig(`backup:\n  when: manual\napi:\n  port: ${String(port)}\n`);
      await expect(start(second.dir, config)).rejects.toThrow();
      // The failed start left nothing behind: no api.json and no held lock.
      expect(await exists(dataPaths(second.dir).apiDiscovery)).toBe(false);
      const retry = await start(second.dir);
      await retry.stop('shutdown');
      await a.stop('shutdown');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('rotates the token through the route and through `ot api rotate-token` while the daemon runs', async () => {
    const tmp = await makeTempDataDir();
    try {
      const daemon = await start(tmp.dir);
      const token = await tokenOf(tmp.dir);
      let closed = 0;
      daemon.api.onTokenRotated(() => {
        closed += 1;
      });

      const result = await ot(tmp.dir, ['api', 'rotate-token']);
      expect(result).toMatchObject({ code: 0, err: [] });
      expect(result.out.join('\n')).toMatch(/API token swapped/);
      const rotated = await tokenOf(tmp.dir);
      expect(rotated).not.toBe(token);
      expect(result.out.join('\n')).not.toContain(rotated);
      expect(closed).toBe(1);
      expect((await get(daemon.api.url, token)).status).toBe(401);
      expect((await get(daemon.api.url, rotated)).status).toBe(200);

      // The token file is old (a copy someone kept): the daemon refuses and the command says so.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(dataPaths(tmp.dir).apiToken, `${token}\n`);
      const refused = await ot(tmp.dir, ['api', 'rotate-token']);
      expect(refused.code).toBe(1);
      expect(refused.err.join('\n')).toMatch(/refused the request \(HTTP 401\)/);
      expect(closed).toBe(1);
      await daemon.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });

  it('a daemon id made on another machine comes back with `ot backup` and `ot restore`', async () => {
    const tmp = await makeTempDataDir();
    try {
      const paths = dataPaths(tmp.dir);
      const first = await start(tmp.dir);
      const id = first.daemonId;
      await first.stop('shutdown');

      const made = await ot(tmp.dir, ['backup']);
      expect(made.code).toBe(0);
      const [name] = await readdir(join(tmp.dir, 'backups'));
      const folder = join(tmp.dir, 'backups', name ?? '');
      expect((await readFile(join(folder, 'daemon-id'), 'utf8')).trim()).toBe(id);

      // The data folder lost its id (a new machine): the next start makes another one.
      await rm(paths.daemonId);
      const other = await start(tmp.dir);
      expect(other.daemonId).not.toBe(id);
      await other.stop('shutdown');

      const restored = await ot(tmp.dir, ['restore', folder]);
      expect(restored).toMatchObject({ code: 0, err: [] });
      expect(restored.out.join('\n')).toMatch(/daemon id of the backup was restored/);
      expect(restored.out.join('\n')).toMatch(
        /previous daemon id file was kept as .*before-restore/,
      );
      const again = await start(tmp.dir);
      expect(again.daemonId).toBe(id);
      await again.stop('shutdown');
    } finally {
      await tmp.dispose();
    }
  });
});
