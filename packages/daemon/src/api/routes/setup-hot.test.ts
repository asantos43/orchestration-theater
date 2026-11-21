// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import type { EventEnvelope } from '@otheater/core';
import type { SetupRunView } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientFactory } from '../../clients.js';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { fixtureOpenCodeCatalog } from '../../executors/opencode-catalog-fixture.js';
import { dataPaths } from '../../paths.js';
import { MINIMAX, MINIMAX_EXECUTOR, MINIMAX_MODEL } from '../../setup/rig-fixture.js';
import { captureLogger, makeTempDataDir } from '../../test-helpers.js';

/**
 * P23 (Phase 7, N208 item 3, N202 (c)): the confirmation of the setup assistant reaches the running
 * daemon with no restart. `GET /v1/config` shows the new roles, Executor and budget right after
 * `setup.confirm`, and `config.changed` lists the hot paths.
 */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let daemon: DaemonHandle;
let token: string;

interface ConfigView {
  config: {
    roles: { preset?: string; author?: { executors?: string[] } };
    executors: { entries: Record<string, { client: string; profile: string; model: string }> };
    profiles: {
      entries: Record<string, { budget?: { daily_usd?: number; monthly_usd?: number } }>;
    };
  };
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${daemon.api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

async function configView(): Promise<ConfigView['config']> {
  return (JSON.parse((await send('GET', '/v1/config')).text) as ConfigView).config;
}

async function eventsOf(type: string): Promise<readonly EventEnvelope[]> {
  const all = await daemon.store.events.readFrom(0, 10_000);
  return all.filter((event) => event.type === type);
}

async function step(runId: string, body: unknown): Promise<SetupRunView> {
  const answer = await send('POST', `/v1/setup/${runId}/step`, body);
  expect(answer.status, answer.text).toBe(200);
  return JSON.parse(answer.text) as SetupRunView;
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  // An API account of OpenCode over the store, and the OpenCode client with the fixture catalog.
  await store.profiles.create({
    client: 'opencode',
    name: 'minimax',
    kind: 'api',
    provider: 'minimax',
    dir: join(tmp.dir, 'profiles', 'opencode', 'minimax'),
    secretRef: 'vault:opencode-minimax',
  });
  const clients: ClientFactory = (parts) => [
    new FakeClientAdapter({
      id: 'opencode',
      launcher: parts.launcher,
      baseEnv: { PATH: '/bin' },
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: ['--acp'] },
      loginState: 'logged_in',
      models: fixtureOpenCodeCatalog({ profileRoot: join(tmp.dir, 'profiles-of-catalog') }).catalog,
    }),
  ];
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clients,
    config: parseConfig('backup:\n  when: manual\n'),
    overrides: { clock, vault: new InMemorySecretVault(), store },
    logger: captureLogger().logger,
    version: '0.0.0-test',
  });
  token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
});

afterEach(async () => {
  await daemon.stop();
  await tmp.dispose();
});

describe('setup.confirm applies the configuration to the running daemon (P23)', () => {
  it('first run: the roles, the Executor and the cap show in GET /v1/config at once, with config.changed', async () => {
    const before = await configView();
    expect(before.executors.entries).toEqual({});
    expect(before.roles.preset).not.toBe('quality');

    const started = await send('POST', '/v1/setup/first_run/start');
    expect(started.status, started.text).toBe(200);
    const run = JSON.parse(started.text) as SetupRunView;
    await step(run.id, { step: 'detect', input: {} });
    await step(run.id, { step: 'preset', input: { preset: 'quality' } });
    await step(run.id, {
      step: 'executors',
      input: { executors: [{ profileId: MINIMAX, model: MINIMAX_MODEL }] },
    });
    // Nothing reached the running daemon before the confirmation.
    expect((await configView()).executors.entries).toEqual({});
    expect(await eventsOf('config.changed')).toHaveLength(0);

    const confirmed = await send('POST', `/v1/setup/${run.id}/confirm`);
    expect(confirmed.status, confirmed.text).toBe(200);

    const after = await configView();
    expect(after.roles.preset).toBe('quality');
    expect(after.roles.author?.executors).toEqual([MINIMAX_EXECUTOR]);
    expect(after.executors.entries[MINIMAX_EXECUTOR]).toMatchObject({
      client: 'opencode',
      profile: 'minimax',
      model: MINIMAX_MODEL,
    });
    expect(after.profiles.entries[MINIMAX]?.budget).toMatchObject({
      daily_usd: 20,
      monthly_usd: 200,
    });

    const changed = await eventsOf('config.changed');
    expect(changed).toHaveLength(1);
    const payload = changed[0]?.payload as { hot: string[]; restart: string[] };
    expect(payload.hot).toEqual(
      expect.arrayContaining([
        'roles.preset',
        'roles.author.executors',
        `executors.${MINIMAX_EXECUTOR}`,
        `profiles.${MINIMAX}.budget`,
      ]),
    );
    expect(payload.restart).toEqual([]);
  });

  it('change_preset: the new preset is in the running configuration right after the confirmation', async () => {
    const run = JSON.parse(
      (await send('POST', '/v1/setup/change_preset/start')).text,
    ) as SetupRunView;
    await step(run.id, { step: 'preset', input: { preset: 'economical' } });
    expect((await configView()).roles.preset).not.toBe('economical');
    const confirmed = await send('POST', `/v1/setup/${run.id}/confirm`);
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await configView()).roles.preset).toBe('economical');
    const changed = await eventsOf('config.changed');
    expect(changed).toHaveLength(1);
    expect((changed[0]?.payload as { hot: string[] }).hot).toContain('roles.preset');
  });
});
