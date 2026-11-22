// SPDX-License-Identifier: MPL-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { ApiUpdateStatusSchema } from '@otheater/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle, type UpdatesOptions } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { dataPaths } from './paths.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';
import { buildRelease, EXE_BYTES, makeKeys, type ReleaseSpec } from './updates/release-fixture.js';

/**
 * The search for updates in a daemon that is running (Phase 10, P7): a version server on a loopback
 * port, a key made here, `GET /v1/updates`, `POST /v1/updates/check`, `GET /metrics` and the
 * events. Nothing reaches a real network and no real key is read.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

/** A version server: `/rel/<file>` answers the files it was given, anything else 404. */
async function versionServer(files: Map<string, Buffer | string>): Promise<string> {
  const server = createServer((request, response) => {
    const served = files.get((request.url ?? '').replace(/^\/rel\//u, ''));
    if (served === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200).end(served);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/rel/`;
}

interface Running {
  readonly daemon: DaemonHandle;
  readonly token: string;
  readonly dir: string;
  readonly get: (path: string) => Promise<Response>;
  readonly post: (path: string) => Promise<Response>;
  readonly events: () => Promise<{ type: string; payload: Record<string, unknown> }[]>;
}

async function withDaemon(
  config: string,
  updates: UpdatesOptions,
  body: (running: Running) => Promise<void>,
): Promise<void> {
  const tmp = await makeTempDataDir();
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(`backup:\n  when: manual\ntelemetry:\n  export: prometheus\n${config}`),
    overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
    logger: createSilentLogger(),
    version: '0.5.0',
    updates: { installKind: 'own', platform: 'linux-x64', ...updates },
  });
  try {
    const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}` };
    await body({
      daemon,
      token,
      dir: tmp.dir,
      get: (path) => fetch(`${daemon.api.url}${path}`, { headers }),
      post: (path) => fetch(`${daemon.api.url}${path}`, { method: 'POST', headers }),
      events: async () => {
        const page = (await daemon.store.events.readFrom(0, 10_000)).filter(
          (event) =>
            event.type === 'daemon.update' ||
            (event.type === 'daemon.notice' &&
              (event.payload as { kind?: unknown }).kind === 'update_rejected'),
        );
        return page.map((event) => ({
          type: event.type,
          payload: event.payload,
        }));
      },
    });
  } finally {
    await daemon.stop();
    await tmp.dispose();
  }
}

function serve(
  files: Map<string, Buffer | string>,
  release: ReturnType<typeof buildRelease>,
): void {
  files.set('manifest.json', release.manifestBytes);
  files.set('manifest.json.sig', release.signature);
  files.set(release.name, release.exe);
}

const urlConfig = (base: string, mode: string, extra = ''): string =>
  `updates:\n  mode: ${mode}\n  source: url\n  url: ${base}\n  check_interval: off\n${extra}`;

const spec = (over: Partial<ReleaseSpec> = {}): ReleaseSpec => ({ version: '0.6.0', ...over });

describe('updates in a running daemon', () => {
  it('notify: a good version is downloaded, checked and stored under the data folder', async () => {
    const keys = makeKeys();
    const files = new Map<string, Buffer | string>();
    serve(files, buildRelease(keys, spec()));
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'notify'), { publicKey: keys.publicPem }, async (r) => {
      await vi.waitFor(async () => {
        const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
        expect(status).toMatchObject({
          mode: 'notify',
          effectiveMode: 'notify',
          installKind: 'own',
          keyState: 'valid',
          currentVersion: '0.5.0',
          found: '0.6.0',
          ready: '0.6.0',
          lastResult: 'ready',
        });
      });
      const staged = join(r.dir, 'updates', 'staging', '0.6.0');
      expect(await readFile(join(staged, 'otheater-0.6.0-linux-x64'))).toEqual(EXE_BYTES);
      expect((await r.events()).map((e) => [e.type, e.payload.phase])).toEqual([
        ['daemon.update', 'found'],
        ['daemon.update', 'downloaded'],
        ['daemon.update', 'verified'],
      ]);
      const metrics = await (await r.get('/metrics')).text();
      expect(metrics).toContain('otheater_updates_checks_total{result="ready"} 1');
      expect(metrics).toContain('otheater_updates_rejected_total{reason="signature"} 0');
    });
  });

  it('a signature of another key never reaches the disk and reaches the notices', async () => {
    const keys = makeKeys();
    const files = new Map<string, Buffer | string>();
    serve(files, buildRelease(makeKeys(), spec()));
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'auto'), { publicKey: keys.publicPem }, async (r) => {
      await vi.waitFor(async () => {
        const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
        expect(status).toMatchObject({
          lastResult: 'rejected',
          lastReason: 'signature',
          ready: null,
        });
        expect(status.notes).toEqual([]);
      });
      expect(await readdir(join(r.dir, 'updates', 'staging')).catch(() => [])).toEqual([]);
      const events = await r.events();
      expect(events.find((e) => e.payload.phase === 'rejected')?.payload).toMatchObject({
        reason: 'signature',
        mode: 'auto',
        effectiveMode: 'auto',
      });
      expect(events.find((e) => e.type === 'daemon.notice')?.payload).toMatchObject({
        kind: 'update_rejected',
        detail: 'signature',
      });
      expect(await (await r.get('/metrics')).text()).toContain(
        'otheater_updates_rejected_total{reason="signature"} 1',
      );
    });
  });

  it('no network: the daemon starts, answers, and says failed', async () => {
    const keys = makeKeys();
    // A port nobody listens on.
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) =>
      dead.close(() => {
        resolve();
      }),
    );
    await withDaemon(
      urlConfig(`http://127.0.0.1:${String(port)}/rel/`, 'notify'),
      { publicKey: keys.publicPem },
      async (r) => {
        expect((await r.get('/v1/status')).status).toBeLessThan(500);
        await vi.waitFor(async () => {
          const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
          expect(status).toMatchObject({ lastResult: 'failed', lastReason: 'no_network' });
        });
        expect((await r.events()).map((e) => e.payload.phase)).toEqual(['failed']);
      },
    );
  });

  it('check: POST /v1/updates/check finds the version and downloads nothing', async () => {
    const keys = makeKeys();
    const files = new Map<string, Buffer | string>();
    // Nothing newer yet: the release on the server is the installed version.
    serve(files, buildRelease(keys, spec({ version: '0.5.0' })));
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'check'), { publicKey: keys.publicPem }, async (r) => {
      await vi.waitFor(async () => {
        const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
        expect(status.lastResult).toBe('up_to_date');
      });
      serve(files, buildRelease(keys, spec()));
      const answer = await r.post('/v1/updates/check');
      expect(answer.status).toBe(200);
      expect(ApiUpdateStatusSchema.parse(await answer.json())).toMatchObject({
        lastResult: 'found',
        found: '0.6.0',
        ready: null,
      });
      expect(await readdir(join(r.dir, 'updates', 'staging')).catch(() => [])).toEqual([]);
    });
  });

  it('off: nothing is asked, and the check answers 409', async () => {
    const keys = makeKeys();
    const files = new Map<string, Buffer | string>();
    serve(files, buildRelease(keys, spec()));
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'off'), { publicKey: keys.publicPem }, async (r) => {
      const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
      expect(status).toMatchObject({ mode: 'off', effectiveMode: 'off', lastResult: null });
      expect((await r.post('/v1/updates/check')).status).toBe(409);
      expect(await r.events()).toEqual([]);
    });
  });

  it('the placeholder key: nothing is searched, and the status says so', async () => {
    const files = new Map<string, Buffer | string>();
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'notify'), { publicKey: 'PLACEHOLDER\n' }, async (r) => {
      const status = ApiUpdateStatusSchema.parse(await (await r.get('/v1/updates')).json());
      expect(status).toMatchObject({ keyState: 'placeholder', effectiveMode: 'check' });
      expect(status.notes).toContain('no_public_key');
    });
  });

  it('asks for the token like every route', async () => {
    const files = new Map<string, Buffer | string>();
    const base = await versionServer(files);
    await withDaemon(urlConfig(base, 'off'), {}, async (r) => {
      expect((await fetch(`${r.daemon.api.url}/v1/updates`)).status).toBe(401);
    });
  });
});
