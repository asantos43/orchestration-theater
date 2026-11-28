// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import type { EventEnvelope } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { dataPaths } from '../../paths.js';
import { captureLogger, makeTempDataDir, NO_CLIENTS, type LoggedLine } from '../../test-helpers.js';

/**
 * The commands of the REST API (P6 of docs/17), against the daemon as it starts: fake clock,
 * in-memory store and vault, no client (nothing real runs). The commands that need the play
 * machinery are in `command-routes.e2e.test.ts`; here, the ones that do not, and what holds for
 * every command: the key, the 400, the events and the absence of secrets.
 */

const API_KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwx';

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  // The type of the body is the test's claim, as a cast would be.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  readonly json: <Body = unknown>() => Body;
}

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let daemon: DaemonHandle;
let token: string;
let clock: FakeClock;
let vault: InMemorySecretVault;
let lines: LoggedLine[];

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    json: <Body>() => JSON.parse(text) as Body,
  };
}

const idem = (key: string): Record<string, string> => ({ 'idempotency-key': key });

async function events(): Promise<readonly EventEnvelope[]> {
  return daemon.store.events.readFrom(0, 10_000);
}

async function eventsOf(type: string): Promise<readonly EventEnvelope[]> {
  return (await events()).filter((event) => event.type === type);
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
  clock = new FakeClock();
  vault = new InMemorySecretVault();
  const captured = captureLogger();
  lines = captured.lines;
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    // No launcher (Windows with `windows_launcher: off`), so the plays are off: an empty pool alone
    // no longer turns them off (P18, N321), the daemon waits for a client to be found.
    // The loops of the triggers of the workflows (P10a) lap once a day: their laps on a fake clock of a day are not
    // what this file tests (the order that expires after 24 h).
    config: parseConfig(
      'backup:\n  when: manual\nprocesses:\n  windows_launcher: off\n' +
        'workflows:\n  triggers:\n    poll:\n      mode: off\n      interval: 1d\n    event_poll: 1d\n',
    ),
    overrides: {
      clock,
      vault,
      store: new InMemoryStore({ clock }),
      launcherDeps: { platform: 'win32' },
    },
    logger: captured.logger,
    version: '0.0.0-test',
  });
  token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
  // The file the configuration commands edit (the daemon above started from a parsed config).
  await writeFile(dataPaths(tmp.dir).config, '# kept by the edit\nbackup:\n  when: manual\n');
});

afterEach(async () => {
  await daemon.stop();
  await tmp.dispose();
});

describe('orders', () => {
  it('creates, extends and revokes an order, each one an event', async () => {
    const created = await send('POST', '/v1/orders', {
      text: 'Answer in Portuguese',
      scope: 'global',
      validity: { for: '2h' },
    });
    expect(created.status, created.text).toBe(200);
    const { order } = created.json<{ order: { id: string; state: string; endsAt: number } }>();
    expect(order.state).toBe('active');
    expect(await eventsOf('directive.created')).toHaveLength(1);

    const extended = await send('POST', `/v1/orders/${order.id}/extend`, {
      validity: { until: null },
    });
    expect(extended.status, extended.text).toBe(200);
    expect(extended.json<{ order: { endsAt: number | null } }>().order.endsAt).toBeNull();
    expect(await eventsOf('directive.validity_changed')).toHaveLength(1);

    const revoked = await send('POST', `/v1/orders/${order.id}/revoke`, { reason: 'not needed' });
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.json<{ order: { state: string } }>().order.state).toBe('revoked');
    expect(await eventsOf('directive.revoked')).toHaveLength(1);
  });

  it('suspends a global order in one scenario with a local suspension', async () => {
    const scenario = await daemon.store.scenarios.create({
      id: 'S1',
      kind: 'project',
      flowId: 'software',
      name: 'one',
      folder: tmp.dir,
      profile: 'software',
    });
    const global = (
      await send('POST', '/v1/orders', { text: 'Keep it short', scope: 'global' })
    ).json<{ order: { id: string } }>().order;
    const suspended = await send('POST', `/v1/orders/${global.id}/suspend`, {
      scenarioId: scenario.id,
    });
    expect(suspended.status, suspended.text).toBe(200);
    const order = suspended.json<{ order: { kind: string; suspendsId: string; scope: string } }>()
      .order;
    expect(order).toMatchObject({ kind: 'suspension', suspendsId: global.id, scope: 'local' });
    expect(await eventsOf('directive.suspended')).toHaveLength(1);
  });

  it('answers 404 for a local order or a suspension in a scenario that does not exist', async () => {
    const global = (
      await send('POST', '/v1/orders', { text: 'Keep it short', scope: 'global' })
    ).json<{ order: { id: string } }>().order;
    const local = await send('POST', '/v1/orders', {
      text: 'Only here',
      scope: 'local',
      scenarioId: 'nope',
    });
    expect(local.status, local.text).toBe(404);
    const suspended = await send('POST', `/v1/orders/${global.id}/suspend`, {
      scenarioId: 'nope',
    });
    expect(suspended.status, suspended.text).toBe(404);
    expect(await daemon.store.directives.list({})).toHaveLength(1);
    expect(await eventsOf('directive.suspended')).toHaveLength(0);
  });

  it('maps the failures of the order service to the codes of the API', async () => {
    const missing = await send('POST', '/v1/orders/nope/revoke', { reason: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('not_found');

    const badValidity = await send('POST', '/v1/orders', {
      text: 'x',
      scope: 'global',
      validity: { for: 'a while' },
    });
    expect(badValidity.status).toBe(400);
    expect(badValidity.json<{ error: { code: string } }>().error.code).toBe('invalid_input');
  });

  it('does not run an order twice for the same Idempotency-Key, and does not repeat the event', async () => {
    const body = { text: 'Answer in Portuguese', scope: 'global' };
    const first = await send('POST', '/v1/orders', body, idem('order-1'));
    const again = await send('POST', '/v1/orders', body, idem('order-1'));
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.text).toBe(first.text);
    expect(await daemon.store.directives.list({})).toHaveLength(1);
    expect(await eventsOf('directive.created')).toHaveLength(1);
    expect(lines.some((line) => line.msg.includes('Idempotency-Key'))).toBe(true);
  });

  it('answers 409 for the same key with another body', async () => {
    await send('POST', '/v1/orders', { text: 'one', scope: 'global' }, idem('order-2'));
    const other = await send(
      'POST',
      '/v1/orders',
      { text: 'two', scope: 'global' },
      idem('order-2'),
    );
    expect(other.status).toBe(409);
    expect(other.json<{ error: { code: string } }>().error.code).toBe('conflict');
    expect(await daemon.store.directives.list({})).toHaveLength(1);
  });

  it('runs again after the key expired (api.idempotency_ttl, 24 h)', async () => {
    const body = { text: 'one', scope: 'global' };
    await send('POST', '/v1/orders', body, idem('order-3'));
    await clock.advance(24 * 3_600_000 + 1);
    const again = await send('POST', '/v1/orders', body, idem('order-3'));
    expect(again.headers.get('idempotency-replayed')).toBeNull();
    expect(await daemon.store.directives.list({})).toHaveLength(2);
  });

  it('does not keep a failure under the key', async () => {
    const failed = await send('POST', '/v1/orders/nope/revoke', { reason: 'x' }, idem('order-4'));
    expect(failed.status).toBe(404);
    const global = (await send('POST', '/v1/orders', { text: 'one', scope: 'global' })).json<{
      order: { id: string };
    }>().order;
    // A key whose first run failed is free: it can be used for another request now.
    const ok = await send(
      'POST',
      `/v1/orders/${global.id}/revoke`,
      { reason: 'x' },
      idem('order-4'),
    );
    expect(ok.status, ok.text).toBe(200);
  });
});

describe('a body that does not fit', () => {
  it('answers 400 invalid_input with the path of each wrong field', async () => {
    const answer = await send('POST', '/v1/orders', { text: '', scope: 'nowhere', extra: 1 });
    expect(answer.status).toBe(400);
    const { error } = answer.json<{
      error: {
        code: string;
        details: { issues: { path: (string | number)[]; message: string }[] };
      };
    }>();
    expect(error.code).toBe('invalid_input');
    const paths = error.details.issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining([['text'], ['scope']]));
    expect(await daemon.store.directives.list({})).toHaveLength(0);
  });

  it('answers 400 for a header that is not a key', async () => {
    const answer = await send(
      'POST',
      '/v1/orders',
      { text: 'x', scope: 'global' },
      { 'idempotency-key': 'bad key with spaces' },
    );
    expect(answer.status).toBe(400);
    expect(await daemon.store.directives.list({})).toHaveLength(0);
  });
});

describe('commands that need the plays', () => {
  it('answers 503 unavailable when the daemon runs none', async () => {
    for (const [method, path, body] of [
      ['POST', '/v1/scenarios', {}],
      ['POST', '/v1/scenarios/x/attachments', { text: 'hello' }],
      ['POST', '/v1/decisions/x/answer', { answer: { option: 'approve' } }],
      ['POST', '/v1/plays/x/cancel', undefined],
      ['POST', '/v1/scenarios/x/ideas', { text: 'an idea' }],
    ] as const) {
      const answer = await send(method, path, body);
      expect(answer.status, `${method} ${path}: ${answer.text}`).toBe(503);
      expect(answer.json<{ error: { code: string } }>().error.code).toBe('unavailable');
    }
  });
});

describe('profiles', () => {
  it('registers an API profile with its key in the vault and nowhere else', async () => {
    const added = await send('POST', '/v1/profiles', {
      client: 'claude-code',
      name: 'work',
      kind: 'api',
      provider: 'anthropic',
      apiKey: API_KEY,
    });
    expect(added.status, added.text).toBe(200);
    const result = added.json<{
      status: string;
      hasSecret: boolean;
      profile: { id: string; secretRef: string | null };
    }>();
    expect(result).toMatchObject({ status: 'added', hasSecret: true });
    expect(result.profile.id).toBe('claude-code/work');

    // The key is in the vault ...
    const ref = result.profile.secretRef;
    expect(ref).not.toBeNull();
    expect((await vault.get(ref ?? ''))?.reveal()).toBe(API_KEY);
    // ... and in no response, no event, no log line.
    expect(added.text).not.toContain(API_KEY);
    expect(JSON.stringify(await events())).not.toContain(API_KEY);
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
    expect(await eventsOf('profile.added')).toHaveLength(1);
  });

  it('keeps the key out of a repeat, a conflict and a refused body', async () => {
    const body = {
      client: 'claude-code',
      name: 'work',
      kind: 'api',
      provider: 'anthropic',
      apiKey: API_KEY,
    };
    const first = await send('POST', '/v1/profiles', body, idem('profile-1'));
    const again = await send('POST', '/v1/profiles', body, idem('profile-1'));
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.text).toBe(first.text);
    expect(await eventsOf('profile.added')).toHaveLength(1);

    const taken = await send('POST', '/v1/profiles', body);
    expect(taken.status).toBe(409);
    const refused = await send('POST', '/v1/profiles', { ...body, name: '', apiKey: API_KEY });
    expect(refused.status).toBe(400);
    for (const answer of [taken, refused]) expect(answer.text).not.toContain(API_KEY);
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
  });

  it('refuses a client the daemon cannot run, with what a screen needs to say it (N326)', async () => {
    const refused = await send('POST', '/v1/profiles', {
      client: 'cursor',
      name: 'main',
      kind: 'token_plan',
      provider: 'anthropic',
    });
    expect(refused.status).toBe(400);
    const error = refused.json<{
      error: { code: string; details?: { reason?: string; client?: string; known?: string[] } };
    }>().error;
    expect(error.code).toBe('invalid_input');
    expect(error.details).toMatchObject({ reason: 'unknown_client', client: 'cursor' });
    expect(error.details?.known).toEqual(expect.arrayContaining(['claude-code', 'codex']));
    expect(await eventsOf('profile.added')).toHaveLength(0);
  });

  it('drains and removes a profile', async () => {
    await send('POST', '/v1/profiles', {
      client: 'claude-code',
      name: 'work',
      kind: 'api',
      provider: 'anthropic',
      apiKey: API_KEY,
    });
    const drained = await send('POST', '/v1/profiles/claude-code/work/drain', { timeoutMs: 0 });
    expect(drained.status, drained.text).toBe(200);
    expect(drained.json<{ profile: { state: string } }>().profile.state).not.toBe('active');
    expect(await eventsOf('profile.draining')).toHaveLength(1);

    const removed = await send('DELETE', '/v1/profiles/claude-code/work?timeoutMs=0');
    expect(removed.status, removed.text).toBe(200);
    expect(removed.json<{ profile: { state: string }; secretDeleted: boolean }>()).toMatchObject({
      profile: { state: 'removed' },
      secretDeleted: true,
    });
    expect(await eventsOf('profile.removed')).toHaveLength(1);

    const missing = await send('POST', '/v1/profiles/claude-code/nobody/drain');
    expect(missing.status).toBe(404);
  });
});

describe('configuration', () => {
  it('edits the file, keeps its comments and says it applies on restart', async () => {
    const file = dataPaths(tmp.dir).config;
    const answer = await send('PUT', '/v1/config', {
      set: [{ path: ['api', 'idempotency_ttl'], value: '1h' }],
      remove: [
        ['backup', 'when'],
        ['not', 'there'],
      ],
    });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.json()).toEqual({
      appliesOn: 'restart',
      set: ['api.idempotency_ttl'],
      removed: ['backup.when'],
      hot: [],
      restart: ['api.idempotency_ttl', 'backup.when'],
    });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# kept by the edit');
    expect(text).toContain('idempotency_ttl: 1h');
    expect(text).not.toContain('when: manual');
    expect(await eventsOf('config.edited')).toHaveLength(1);
    expect(await eventsOf('config.changed')).toHaveLength(0);
  });

  it('takes in the hot sections at once, with config.changed, and leaves the rest for a restart (N188)', async () => {
    const before = await send('GET', '/v1/config');
    expect(before.json<{ config: { limits: { preset: string } } }>().config.limits.preset).toBe(
      'moderate',
    );
    const answer = await send('PUT', '/v1/config', {
      set: [
        { path: ['limits', 'preset'], value: 'persistent' },
        { path: ['limits', 'submit_retries'], value: 7 },
        { path: ['chat', 'presence'], value: 'never' },
        { path: ['api', 'idempotency_ttl'], value: '2h' },
      ],
    });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.json()).toEqual({
      appliesOn: 'mixed',
      set: ['limits.preset', 'limits.submit_retries', 'chat.presence', 'api.idempotency_ttl'],
      removed: [],
      hot: ['limits.preset', 'limits.submit_retries', 'chat.presence'],
      restart: ['api.idempotency_ttl'],
    });
    const after = (await send('GET', '/v1/config')).json<{
      config: {
        limits: { preset: string; submit_retries: number };
        chat: { presence: string };
        api: { idempotency_ttl: unknown };
      };
    }>().config;
    // The hot keys changed in the running daemon, with no restart...
    expect(after.limits).toMatchObject({ preset: 'persistent', submit_retries: 7 });
    expect(after.chat.presence).toBe('never');
    // ...and the key that needs a restart did not.
    expect(after.api.idempotency_ttl).not.toBe('2h');
    const changed = await eventsOf('config.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toEqual({
      hot: ['limits.preset', 'limits.submit_retries', 'chat.presence'],
      restart: ['api.idempotency_ttl'],
    });
    expect((await eventsOf('config.edited'))[0]?.payload).toMatchObject({ appliesOn: 'mixed' });
  });

  it('removes a hot key and goes back to its default at once, answering hot', async () => {
    await send('PUT', '/v1/config', { set: [{ path: ['limits', 'submit_retries'], value: 9 }] });
    const answer = await send('PUT', '/v1/config', { remove: [['limits', 'submit_retries']] });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.json()).toMatchObject({ appliesOn: 'hot', hot: ['limits.submit_retries'] });
    const config = (await send('GET', '/v1/config')).json<{
      config: { limits: { submit_retries: number } };
    }>().config;
    expect(config.limits.submit_retries).not.toBe(9);
    expect(await eventsOf('config.changed')).toHaveLength(2);
  });

  it('keeps the running configuration and the file when a hot key is invalid, naming it', async () => {
    const before = await readFile(dataPaths(tmp.dir).config, 'utf8');
    const answer = await send('PUT', '/v1/config', {
      set: [
        { path: ['limits', 'preset'], value: 'persistent' },
        { path: ['roles', 'reviewer', 'when_exhausted'], value: 'sometimes' },
      ],
    });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('when_exhausted');
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8')).toBe(before);
    const config = (await send('GET', '/v1/config')).json<{
      config: { limits: { preset: string } };
    }>().config;
    expect(config.limits.preset).toBe('moderate');
    expect(await eventsOf('config.edited')).toHaveLength(0);
    expect(await eventsOf('config.changed')).toHaveLength(0);
  });

  it('refuses an edit the daemon would not start with, naming the key and not the file', async () => {
    const answer = await send('PUT', '/v1/config', {
      set: [{ path: ['api', 'idempotency_ttl'], value: 'whenever' }],
    });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('idempotency_ttl');
    expect(answer.text).not.toContain(tmp.dir);
    expect(await eventsOf('config.edited')).toHaveLength(0);
    expect(await readFile(dataPaths(tmp.dir).config, 'utf8')).not.toContain('whenever');
  });

  it('refuses a value that looks like a secret, and never writes or records it', async () => {
    const answer = await send('PUT', '/v1/config', {
      set: [{ path: ['clients', 'codex', 'env', 'OPENAI_API_KEY'], value: API_KEY }],
    });
    expect(answer.status).toBe(400);
    expect(answer.text).not.toContain(API_KEY);
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
    await expect(readFile(dataPaths(tmp.dir).config, 'utf8')).resolves.not.toContain(API_KEY);
  });

  it('answers 400 for an edit with nothing in it', async () => {
    const answer = await send('PUT', '/v1/config', {});
    expect(answer.status).toBe(400);
  });

  it('puts edits that arrive together one after the other, losing none', async () => {
    const answers = await Promise.all([
      send('PUT', '/v1/config', { set: [{ path: ['api', 'idempotency_ttl'], value: '1h' }] }),
      send('PUT', '/v1/config', { set: [{ path: ['directives', 'timezone'], value: 'UTC' }] }),
      send('PUT', '/v1/config', { remove: [['backup', 'when']] }),
    ]);
    for (const answer of answers) expect(answer.status, answer.text).toBe(200);
    const text = await readFile(dataPaths(tmp.dir).config, 'utf8');
    expect(text).toContain('idempotency_ttl: 1h');
    expect(text).toContain('timezone: UTC');
    expect(text).not.toContain('when: manual');
    expect(await eventsOf('config.edited')).toHaveLength(3);
  });
});
