// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import type { EventEnvelope } from '@otheater/core';
import type { SetupRunView } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { dataPaths } from '../../paths.js';
import { captureLogger, makeTempDataDir, NO_CLIENTS } from '../../test-helpers.js';

/**
 * The routes of the setup assistant (P4 of docs/18) against the daemon as it starts: fake clock,
 * in-memory store and vault, no client (nothing real runs). The flow itself is tested in
 * `setup/service.test.ts`; here, what the HTTP layer adds: the paths (`/v1/setup/:flow/start` next
 * to `/v1/setup/:runId/step`), the `Idempotency-Key`, the codes of the errors and the events.
 */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let daemon: DaemonHandle;
let token: string;

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string; view: () => SetupRunView }> {
  const response = await fetch(`${daemon.api.url}${path}`, {
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
    view: () => JSON.parse(text) as SetupRunView,
  };
}

async function setupEvents(): Promise<string[]> {
  const all: readonly EventEnvelope[] = await daemon.store.events.readFrom(0, 10_000);
  return all.map((event) => event.type).filter((type) => type.startsWith('setup.'));
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
  const clock = new FakeClock();
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig('backup:\n  when: manual\n'),
    overrides: { clock, vault: new InMemorySecretVault(), store: new InMemoryStore({ clock }) },
    logger: captureLogger().logger,
    version: '0.0.0-test',
  });
  token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
});

afterEach(async () => {
  await daemon.stop();
  await tmp.dispose();
});

describe('the setup routes', () => {
  it('tells that a first run is needed, with no run in progress', async () => {
    const answer = await send('GET', '/v1/setup');
    expect(answer.status, answer.text).toBe(200);
    expect(JSON.parse(answer.text)).toMatchObject({
      firstRunNeeded: true,
      flows: [
        { flow: 'first_run', active: null },
        { flow: 'add_account', active: null },
        { flow: 'change_preset', active: null },
      ],
    });
  });

  it('runs change_preset through the six paths: start, step, back, step, confirm', async () => {
    const started = await send('POST', '/v1/setup/change_preset/start', undefined, {
      'idempotency-key': 'start-1',
    });
    expect(started.status, started.text).toBe(200);
    const run = started.view();
    expect(run).toMatchObject({ flow: 'change_preset', state: 'active', step: 'preset' });

    const wrongStep = await send('POST', `/v1/setup/${run.id}/step`, {
      step: 'review',
      input: {},
    });
    expect(wrongStep.status).toBe(400);

    const answered = await send('POST', `/v1/setup/${run.id}/step`, {
      step: 'preset',
      input: { preset: 'economical' },
    });
    expect(answered.status, answered.text).toBe(200);
    expect(answered.view().step).toBe('review');

    const back = await send('POST', `/v1/setup/${run.id}/back`);
    expect(back.view()).toMatchObject({ step: 'preset', done: [] });
    await send('POST', `/v1/setup/${run.id}/step`, {
      step: 'preset',
      input: { preset: 'balanced' },
    });
    // Nothing is in the file before the confirmation.
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8').catch(() => '')).toBe('');

    const confirmed = await send('POST', `/v1/setup/${run.id}/confirm`, undefined, {
      'idempotency-key': 'confirm-1',
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.view()).toMatchObject({ state: 'confirmed', result: { preset: 'balanced' } });
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8')).toContain('preset: balanced');

    // The same key again is the same answer, and writes nothing twice.
    const again = await send('POST', `/v1/setup/${run.id}/confirm`, undefined, {
      'idempotency-key': 'confirm-1',
    });
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.text).toBe(confirmed.text);

    expect(await setupEvents()).toEqual([
      'setup.started',
      'setup.step',
      'setup.back',
      'setup.step',
      'setup.confirmed',
    ]);
  });

  it('cancels a run and leaves the file as it was', async () => {
    const run = (await send('POST', '/v1/setup/first_run/start')).view();
    const cancelled = await send('POST', `/v1/setup/${run.id}/cancel`);
    expect(cancelled.view().state).toBe('cancelled');
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8').catch(() => '')).toBe('');
    const again = await send('POST', `/v1/setup/${run.id}/cancel`);
    expect(again.status).toBe(409);
    expect(await setupEvents()).toEqual(['setup.started', 'setup.cancelled']);
  });

  it('answers 409 for a second run of a flow, 404 for a run that does not exist, 400 for a bad flow', async () => {
    const first = await send('POST', '/v1/setup/first_run/start');
    expect(first.status).toBe(200);
    const second = await send('POST', '/v1/setup/first_run/start');
    expect(second.status).toBe(409);
    expect(second.text).toContain(first.view().id);

    const missing = await send('POST', '/v1/setup/SR999/cancel');
    expect(missing.status).toBe(404);
    const bad = await send('POST', '/v1/setup/no_such_flow/start');
    expect(bad.status).toBe(400);
  });

  it('GET /v1/setup/models/:client/:name gives the models of an account, and 404 for one that does not exist (N324)', async () => {
    await daemon.store.profiles.create({
      client: 'codex',
      name: 'main',
      kind: 'token_plan',
      provider: 'openai',
      dir: join(tmp.dir, 'profiles', 'codex', 'main'),
      secretRef: null,
    });
    const answer = await send('GET', '/v1/setup/models/codex/main');
    expect(answer.status, answer.text).toBe(200);
    const models = JSON.parse(answer.text) as { profileId: string; kind: string; preset: unknown };
    expect(models).toMatchObject({ profileId: 'codex/main', kind: 'token_plan' });
    expect(typeof models.preset).toBe('string');
    expect((await send('GET', '/v1/setup/models/codex/ghost')).status).toBe(404);
  });

  it('first run with no client: detects nothing, and the confirmation writes only the preset', async () => {
    const run = (await send('POST', '/v1/setup/first_run/start')).view();
    expect(run.prompt).toMatchObject({
      step: 'detect',
      clients: [
        { client: 'claude-code', installed: false },
        { client: 'codex', installed: false },
        { client: 'opencode', installed: false },
      ],
      profiles: [],
    });
    await send('POST', `/v1/setup/${run.id}/step`, { step: 'detect', input: {} });
    await send('POST', `/v1/setup/${run.id}/step`, {
      step: 'preset',
      input: { preset: 'quality' },
    });
    const review = await send('POST', `/v1/setup/${run.id}/step`, { step: 'executors', input: {} });
    expect(review.view().prompt).toMatchObject({
      step: 'review',
      plan: { preset: 'quality', executors: [], budgets: [] },
    });
    expect(review.text).toContain('no_accounts');
    const done = await send('POST', `/v1/setup/${run.id}/confirm`);
    expect(done.status, done.text).toBe(200);
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8')).toContain('preset: quality');
  });

  // No override of the store: the daemon opens its own SQLite file in the data directory, which is
  // what survives a restart.
  it('after the daemon restarts on the same data directory, the run is at the same step', async () => {
    await daemon.stop();
    const other = await makeTempDataDir();
    const dir = other.dir;
    const open = async (): Promise<DaemonHandle> =>
      startDaemon({
        dataDir: dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig('backup:\n  when: manual\n'),
        overrides: { clock: new FakeClock(), vault: new InMemorySecretVault() },
        logger: captureLogger().logger,
        version: '0.0.0-test',
      });
    daemon = await open();
    token = (await readFile(dataPaths(dir).apiToken, 'utf8')).trim();
    const started = await send('POST', '/v1/setup/first_run/start', {});
    const run = started.view();
    const first = await send('POST', `/v1/setup/${run.id}/step`, { step: 'detect', input: {} });
    expect(first.status).toBe(200);
    await daemon.stop();

    daemon = await open();
    token = (await readFile(dataPaths(dir).apiToken, 'utf8')).trim();
    const overview = JSON.parse((await send('GET', '/v1/setup')).text) as {
      flows: { flow: string; active: SetupRunView | null }[];
    };
    const active = overview.flows.find((flow) => flow.flow === 'first_run')?.active;
    expect(active?.id).toBe(run.id);
    expect(active?.step).toBe('preset');
    expect(active?.done.map((entry) => entry.step)).toEqual(['detect']);
    const next = await send('POST', `/v1/setup/${run.id}/step`, {
      step: 'preset',
      input: { preset: 'balanced' },
    });
    expect(next.status).toBe(200);
    await daemon.stop();
    await other.dispose();
  });
});
