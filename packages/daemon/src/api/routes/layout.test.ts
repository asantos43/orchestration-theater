// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { LAYOUT_VERSION, defaultLayout, type LayoutPreferences } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { dataPaths } from '../../paths.js';
import { captureLogger, makeTempDataDir, NO_CLIENTS, type LoggedLine } from '../../test-helpers.js';

/**
 * The layout preferences over the REST API (P12 of docs/17), against the daemon as it starts: the
 * preferences saved by one client come back to a new client, and also after the daemon restarts; a
 * record that cannot be used is replaced by the default, with a warning and an event, and does not
 * stop the start. Fake clock, in-memory store and vault, no client (nothing real runs).
 */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let daemon: DaemonHandle | undefined;

function running(): DaemonHandle {
  if (daemon === undefined) throw new Error('the daemon is not running');
  return daemon;
}
let lines: LoggedLine[];

const SAVED: LayoutPreferences = {
  version: LAYOUT_VERSION,
  sidebarCollapsed: true,
  chatWidth: 90,
  openTabs: ['overview', 'plays'],
  collapsedSections: ['quotas'],
};

async function start(): Promise<DaemonHandle> {
  const clock = new FakeClock();
  const captured = captureLogger();
  lines = captured.lines;
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig('backup:\n  when: manual\n'),
    overrides: { clock, vault: new InMemorySecretVault(), store: new InMemoryStore({ clock }) },
    logger: captured.logger,
    version: '0.0.0-test',
  });
  return daemon;
}

async function stop(): Promise<void> {
  await daemon?.stop();
  daemon = undefined;
}

/** A client: its own token read and its own `fetch`, like two programs that talk to the daemon. */
async function client(handle: DaemonHandle) {
  const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
  return async (method: string, path: string, body?: unknown, headers = {}) => {
    const response = await fetch(`${handle.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: JSON.parse(text) as unknown,
    };
  };
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
});

afterEach(async () => {
  await stop();
  await tmp.dispose();
});

describe('the layout over REST', () => {
  it('serves the default of each interface before anything was saved', async () => {
    const send = await client(await start());
    expect((await send('GET', '/v1/layout/tui')).json).toEqual(defaultLayout('tui'));
    expect((await send('GET', '/v1/layout/web')).json).toEqual(defaultLayout('web'));
    expect((await send('GET', '/v1/layout/other')).status).toBe(400);
    // The keys a client reads to know where to keep its layout come with the effective config.
    const config = (await send('GET', '/v1/config')).json as {
      config: { ui: { layout: unknown } };
    };
    expect(config.config.ui.layout).toEqual({ store: 'daemon', write_delay: 300 });
  });

  it('gives a new client what another one saved, and keeps it after a restart', async () => {
    const a = await client(await start());
    const saved = await a('PUT', '/v1/layout/tui', SAVED);
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toEqual(SAVED);

    const b = await client(running());
    expect((await b('GET', '/v1/layout/tui')).json).toEqual(SAVED);
    // The other interface is not touched.
    expect((await b('GET', '/v1/layout/web')).json).toEqual(defaultLayout('web'));

    await stop();
    const c = await client(await start());
    expect((await c('GET', '/v1/layout/tui')).json).toEqual(SAVED);
    expect((await c('GET', '/v1/layout/web')).json).toEqual(defaultLayout('web'));
    // A normal save is not an event, and nothing needed a warning.
    const types = (await running().store.events.readFrom(0, 10_000)).map((event) => event.type);
    expect(types).not.toContain('layout.adjusted');
    expect(
      lines.filter((line) => line.level === 'warn' && line.msg.includes('layout')),
    ).toHaveLength(0);
  });

  it('refuses a body outside the schema and keeps what was saved', async () => {
    const send = await client(await start());
    await send('PUT', '/v1/layout/web', SAVED);
    for (const body of [
      { ...SAVED, chatWidth: 0 },
      { ...SAVED, version: LAYOUT_VERSION + 1 },
      { ...SAVED, openTabs: [''] },
      { ...SAVED, extra: true },
      {},
    ]) {
      const refused = await send('PUT', '/v1/layout/web', body);
      expect(refused.status, refused.text).toBe(400);
    }
    expect((await send('GET', '/v1/layout/web')).json).toEqual(SAVED);
  });

  it('takes the same save twice as one: the body is the whole record, so no key is needed', async () => {
    const send = await client(await start());
    const first = await send('PUT', '/v1/layout/tui', SAVED);
    const again = await send('PUT', '/v1/layout/tui', SAVED);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect((await send('GET', '/v1/layout/tui')).json).toEqual(SAVED);
  });

  it('replaces a record it cannot use, with a warning and an event, and still starts', async () => {
    const file = join(dataPaths(tmp.dir).layout, 'web.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...SAVED, version: LAYOUT_VERSION + 1 }));
    await writeFile(join(dirname(file), 'tui.json'), '{ not json');

    const handle = await start();
    const send = await client(handle);
    expect((await send('GET', '/v1/layout/web')).json).toEqual(defaultLayout('web'));
    expect((await send('GET', '/v1/layout/tui')).json).toEqual(defaultLayout('tui'));
    expect(
      lines.filter((line) => line.level === 'warn' && line.msg.includes('layout')),
    ).toHaveLength(2);

    // The event is written once the log opens; it is there by the time a client can ask.
    const adjusted = (await handle.store.events.readFrom(0, 10_000))
      .filter((event) => event.type === 'layout.adjusted')
      .map((event) => event.payload as { interface: string; reason: string });
    expect(adjusted.map((event) => `${event.interface}:${event.reason}`).sort()).toEqual([
      'tui:invalid',
      'web:newer_version',
    ]);
  });
});
