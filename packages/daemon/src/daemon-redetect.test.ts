// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import {
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { SetupRedetectResult } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import type { FindExecutable } from './clients.js';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle, type StartDaemonOptions } from './daemon.js';
import { dataPaths } from './paths.js';
import { FakeCommandRunner } from './service/service-fixture.js';
import { captureLogger, makeTempDataDir } from './test-helpers.js';
import { REGISTRY_PATH_KEYS } from './windows-path.js';

/**
 * P18 (N321): the daemon looks for the clients again without a restart. A client installed after
 * the start enters the pool when the setup assistant opens (`redetect: auto`), when an account is
 * added, or when the assistant asks (`POST /v1/setup/redetect`, the R key). Only fakes: the search
 * of `PATH` answers from a set the test changes, and nothing is installed or started.
 */

const MANUAL = 'backup:\n  when: manual\n';

interface Rig {
  readonly daemon: DaemonHandle;
  /** The executables the fake search of `PATH` finds now. */
  readonly have: Set<string>;
  readonly lines: ReturnType<typeof captureLogger>['lines'];
  send(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
  notices(kind: string): Promise<{ subject: string | null; detail: string | null }[]>;
  dispose(): Promise<void>;
}

async function start(
  config: string,
  search: Partial<NonNullable<StartDaemonOptions['clientSearch']>> = {},
): Promise<Rig> {
  const tmp = await makeTempDataDir();
  const { logger, lines } = captureLogger();
  const have = new Set<string>();
  const find: FindExecutable = (command) => (have.has(command) ? `/bin/${command}` : undefined);
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config: parseConfig(config),
    overrides: {
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      launcher: new FakeProcessLauncher(),
      transport: new FakeSessionTransport(),
    },
    clientSearch: {
      env: { PATH: '/usr/bin' },
      findExecutable: find,
      adapters: { fetch: () => Promise.reject(new Error('offline')) },
      ...search,
    },
    logger,
    version: '0.0.0-test',
  });
  const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
  let key = 0;
  return {
    daemon,
    have,
    lines,
    send: async (method, path, body) => {
      key += 1;
      const response = await fetch(`${daemon.api.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `redetect-${String(key)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    },
    notices: async (kind) => {
      const events = await daemon.store.events.readFrom(0, 10_000);
      return events
        .filter((event) => event.type === 'daemon.notice')
        .map(
          (event) =>
            event.payload as { kind: string; subject: string | null; detail: string | null },
        )
        .filter((payload) => payload.kind === kind)
        .map(({ subject, detail }) => ({ subject, detail }));
    },
    dispose: async () => {
      await daemon.stop();
      await tmp.dispose();
    },
  };
}

describe('startDaemon looks for the clients again (P18, N321)', () => {
  it('builds the execution with an empty pool, and opening the assistant adds a client installed later', async () => {
    const t = await start(MANUAL);
    try {
      expect(t.daemon.execution).toBeDefined();
      expect(t.daemon.execution?.pool.clients()).toEqual([]);
      expect(t.daemon.clients?.reasonOf('codex')).toBe('not_found');

      t.have.add('codex-acp');
      const overview = await t.send('GET', '/v1/setup');
      expect(overview.status, overview.text).toBe(200);
      expect(t.daemon.execution?.pool.clients()).toEqual(['codex']);
      expect(await t.notices('client_added')).toEqual([
        { subject: 'codex', detail: 'found_in_path' },
      ]);
      expect(t.lines.some((l) => l.msg === 'client found after the start; added to the pool')).toBe(
        true,
      );

      // A run that starts shows the client as installed, with why.
      const started = await t.send('POST', '/v1/setup/first_run/start');
      expect(started.status, started.text).toBe(200);
      const view = JSON.parse(started.text) as {
        facts?: unknown;
      };
      expect(JSON.stringify(view)).toContain(
        '"client":"codex","installed":true,"reason":"found_in_path"',
      );
      expect(JSON.stringify(view)).toContain(
        '"client":"opencode","installed":false,"reason":"not_found"',
      );
    } finally {
      await t.dispose();
    }
  });

  it('POST /v1/setup/redetect looks even with redetect: manual, which the assistant opening does not', async () => {
    const t = await start(`${MANUAL}clients:\n  detection: { redetect: manual }\n`);
    try {
      t.have.add('codex-acp');
      expect((await t.send('GET', '/v1/setup')).status).toBe(200);
      expect(t.daemon.execution?.pool.clients()).toEqual([]);

      const asked = await t.send('POST', '/v1/setup/redetect');
      expect(asked.status, asked.text).toBe(200);
      const result = JSON.parse(asked.text) as SetupRedetectResult;
      expect(result.added).toEqual(['codex']);
      expect(result.clients).toEqual([
        { client: 'claude-code', installed: false, reason: 'not_found' },
        { client: 'codex', installed: true, reason: 'found_in_path' },
        { client: 'opencode', installed: false, reason: 'not_found' },
      ]);
      expect(t.daemon.execution?.pool.clients()).toEqual(['codex']);

      // Asked again with nothing new: nothing is added and the pool is the same.
      const again = JSON.parse(
        (await t.send('POST', '/v1/setup/redetect')).text,
      ) as SetupRedetectResult;
      expect(again.added).toEqual([]);
      expect(await t.notices('client_added')).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('a client disabled by the config stays out, with its reason', async () => {
    const t = await start(`${MANUAL}clients:\n  codex: { enabled: false }\n`);
    try {
      t.have.add('codex-acp');
      const result = JSON.parse(
        (await t.send('POST', '/v1/setup/redetect')).text,
      ) as SetupRedetectResult;
      expect(result.added).toEqual([]);
      expect(result.clients.find((c) => c.client === 'codex')).toEqual({
        client: 'codex',
        installed: false,
        reason: 'disabled',
      });
    } finally {
      await t.dispose();
    }
  });

  it('on Windows a Path of the registry that cannot be read is told, and the start goes on', async () => {
    const run = new FakeCommandRunner().on('reg', { code: 5, stderr: 'Access is denied.' });
    const t = await start(MANUAL, { platform: 'win32', registryRunner: run.run });
    try {
      expect(run.lines).toEqual(REGISTRY_PATH_KEYS.map((key) => `reg query ${key} /v Path`));
      expect(await t.notices('client_path_unreadable')).toEqual(
        REGISTRY_PATH_KEYS.map((key) => ({ subject: key, detail: null })),
      );
      expect(t.daemon.execution).toBeDefined();
    } finally {
      await t.dispose();
    }
  });

  it('on Windows the registry is read again at each search, and clients.detection.path: process reads none', async () => {
    const run = new FakeCommandRunner().on('reg', {
      stdout: '\r\nHKCU\\Environment\r\n    Path    REG_SZ    C:\\new\r\n',
    });
    const t = await start(MANUAL, {
      platform: 'win32',
      registryRunner: run.run,
      env: { Path: 'C:\\old' },
    });
    try {
      expect(run.calls).toHaveLength(2);
      expect(
        t.lines.some((l) => l.msg.startsWith('folders of the Path of the registry added')),
      ).toBe(true);
      await t.send('POST', '/v1/setup/redetect');
      expect(run.calls).toHaveLength(4);
    } finally {
      await t.dispose();
    }

    const none = new FakeCommandRunner();
    const p = await start(`${MANUAL}clients:\n  detection: { path: process }\n`, {
      platform: 'win32',
      registryRunner: none.run,
    });
    try {
      await p.send('POST', '/v1/setup/redetect');
      expect(none.calls).toEqual([]);
    } finally {
      await p.dispose();
    }
  });
});
