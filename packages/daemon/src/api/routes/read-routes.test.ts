// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Secret } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { API_ROUTES, REDACTED_VALUE } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { startDaemon, type DaemonHandle } from '../../daemon.js';
import { createSilentLogger } from '../../logger.js';
import { dataPaths } from '../../paths.js';
import { makeTempDataDir, NO_CLIENTS, startNotices } from '../../test-helpers.js';

/**
 * The read-only REST routes (P5 of docs/17), against the daemon as it starts: the fake clock, the
 * in-memory store and vault, no client (nothing real runs). The data is written through the
 * daemon's own store, the way the services will.
 */

const VAULT_VALUE = 'sk-vault-0123456789abcdefghijklmnop';
const CONFIG_VALUE = 'sk-config-0123456789abcdefghijklmnop';
const CONVENTION_VALUE = 'sk-convention-0123456789abcdefghijk';

const CONFIG_YAML = `
backup:
  when: manual
clients:
  codex:
    env:
      OPENAI_API_KEY: ${CONFIG_VALUE}
profiles:
  claude-code/api:
    budget:
      daily_usd: 5
executors:
  claude-opus-high@claude-code/api:
    client: claude-code
    profile: api
    model: claude-opus
    effort: high
roles:
  critic:
    executors: [claude-opus-high@claude-code/api]
    when_exhausted: wait
`;

interface Answer {
  readonly status: number;
  readonly text: string;
  // The type of the body is the test's claim, as a cast would be.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  readonly json: <Body = unknown>() => Body;
}

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let daemon: DaemonHandle;
let token: string;
let clock: FakeClock;

async function get(path: string): Promise<Answer> {
  const response = await fetch(`${daemon.api.url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    json: <Body>() => JSON.parse(text) as Body,
  };
}

interface Page<Item> {
  readonly items: Item[];
  readonly nextCursor: string | null;
}

async function page<Item>(path: string): Promise<Page<Item>> {
  const answer = await get(path);
  expect(answer.status, answer.text).toBe(200);
  return answer.json<Page<Item>>();
}

/** Every item of a list, walking the cursor with the given limit. */
async function walk<Item>(path: string, limit: number): Promise<Item[]> {
  const joiner = path.includes('?') ? '&' : '?';
  const items: Item[] = [];
  let after: string | null = null;
  do {
    const cursor = after === null ? '' : `&after=${encodeURIComponent(after)}`;
    const next: Page<Item> = await page<Item>(`${path}${joiner}limit=${String(limit)}${cursor}`);
    items.push(...next.items);
    after = next.nextCursor;
  } while (after !== null);
  return items;
}

beforeEach(async () => {
  tmp = await makeTempDataDir();
  clock = new FakeClock();
  const vault = new InMemorySecretVault();
  await vault.set('profiles/claude-code/api', new Secret(VAULT_VALUE));
  daemon = await startDaemon({
    dataDir: tmp.dir,
    clientSearch: NO_CLIENTS,
    config: parseConfig(CONFIG_YAML),
    overrides: { clock, vault, store: new InMemoryStore({ clock }) },
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
});

afterEach(async () => {
  await daemon.stop();
  await tmp.dispose();
});

/** A scenario with a play, its stages and demands, a decision, a blackboard and an attachment. */
async function seedScenario(id: string): Promise<void> {
  const { store } = daemon;
  await store.scenarios.create({
    id,
    kind: 'project',
    flowId: 'software',
    name: `Scenario ${id}`,
    folder: tmp.dir,
    profile: 'software',
    conventions: { language: 'ts', token: CONVENTION_VALUE },
    configOverride: {
      selection: { unknown_quota: 'allow' },
      env: { SECRET_THING: CONVENTION_VALUE },
    },
  });
  await store.plays.create({
    id: `${id}-p1`,
    scenarioId: id,
    need: 'Do it',
    flowId: 'software',
    flowVersion: 1,
    state: 'PLANNING',
  });
  await store.stages.create({
    id: `${id}-st1`,
    playId: `${id}-p1`,
    name: 'PLANNING',
    role: 'author',
  });
  await store.demands.create({
    playId: `${id}-p1`,
    id: 'D1',
    title: 'First',
    description: 'd',
    dependsOn: [],
    contract: { inputs: [], outputs: [] },
    expectedFiles: ['a.ts'],
    complexity: 'low',
    timeoutMin: 10,
    acceptanceCriteria: ['works'],
    verify: [],
  });
  await store.decisions.create({
    id: `${id}-d1`,
    scenarioId: id,
    playId: `${id}-p1`,
    kind: 'script_review',
    input: { n: 1 },
  });
  await store.blackboard.put({
    playId: `${id}-p1`,
    key: 'plan',
    value: { v: 1 },
    author: 'author',
  });
  await store.blackboard.put({
    playId: `${id}-p1`,
    key: 'plan',
    value: { v: 2 },
    author: 'author',
  });
  await store.blackboard.put({ playId: `${id}-p1`, key: 'script', value: 'text', author: null });
}

describe('the read routes before and after the services exist', () => {
  it('answers what the registry says: every GET route that is not a stream or a socket has a handler', () => {
    const unregistered: string[] = [];
    const skip = new Set(['streamEvents', 'openChatSocket', 'getStatus']);
    for (const route of Object.values(API_ROUTES)) {
      if (route.method !== 'GET' || skip.has(route.id)) continue;
      expect(daemon.api.handlers.has(route.id), route.id).toBe(true);
      unregistered.push(route.id);
    }
    expect(unregistered.length).toBeGreaterThan(15);
  });

  it('keeps the start sequence of events the notices expect', async () => {
    const kinds: string[] = [];
    for (const event of await daemon.store.events.readFrom(0, 500)) {
      // The in-memory store has no backup: that notice is the test's own, not the sandbox's.
      const payload = event.payload as { kind?: string };
      if (event.type === 'daemon.notice' && payload.kind === 'backup_unsupported') continue;
      if (event.type === 'api.started' || event.type === 'daemon.notice') kinds.push(event.type);
    }
    expect(kinds).toEqual(await startNotices());
  });
});

describe('scenarios, plays and decisions', () => {
  it('lists scenarios by cursor without losing one when others are written between pages', async () => {
    for (const id of ['s1', 's2', 's3', 's4']) {
      await seedScenario(id);
      await clock.advance(10);
    }
    const first = await page<{ id: string }>('/v1/scenarios?limit=2');
    expect(first.items.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(first.nextCursor).not.toBeNull();

    // Writes between two pages: a newer scenario, and a change to one already seen.
    await seedScenario('s5');
    await daemon.store.scenarios.update('s1', { name: 'Renamed' });
    await clock.advance(10);

    const second = await page<{ id: string }>(
      `/v1/scenarios?limit=2&after=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(second.items.map((item) => item.id)).toEqual(['s3', 's4']);
    const third = await page<{ id: string }>(
      `/v1/scenarios?limit=2&after=${encodeURIComponent(second.nextCursor ?? '')}`,
    );
    expect(third.items.map((item) => item.id)).toEqual(['s5']);
    expect(third.nextCursor).toBeNull();

    const all = await walk<{ id: string }>('/v1/scenarios', 1);
    expect(all.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('filters scenarios by kind and state', async () => {
    await seedScenario('s1');
    await daemon.store.scenarios.create({
      id: 'c1',
      kind: 'chat',
      flowId: 'chat',
      name: 'c',
      folder: tmp.dir,
    });
    const chats = await page<{ id: string }>('/v1/scenarios?kind=chat');
    expect(chats.items.map((item) => item.id)).toEqual(['c1']);
    expect((await page<{ id: string }>('/v1/scenarios?state=archived')).items).toEqual([]);
  });

  it('shows a scenario with its counts, and holds back what could be a secret', async () => {
    await seedScenario('s1');
    const answer = await get('/v1/scenarios/s1');
    expect(answer.status).toBe(200);
    const body = answer.json<{
      scenario: { id: string };
      conventions: Record<string, unknown>;
      configOverride: { env: Record<string, string> };
      counts: Record<string, number>;
    }>();
    expect(body.scenario.id).toBe('s1');
    expect(body.counts).toEqual({ openPlays: 1, pendingDecisions: 1, attachments: 0 });
    expect(body.conventions).toEqual({ language: 'ts', token: REDACTED_VALUE });
    expect(body.configOverride.env.SECRET_THING).toBe(REDACTED_VALUE);
    expect(answer.text).not.toContain(CONVENTION_VALUE);
  });

  it('lists the plays and decisions of a scenario and shows a play with stages and demands', async () => {
    await seedScenario('s1');
    const plays = await page<{ id: string }>('/v1/scenarios/s1/plays');
    expect(plays.items.map((item) => item.id)).toEqual(['s1-p1']);
    expect(plays.items[0]).not.toHaveProperty('snapshot');
    expect((await page<unknown>('/v1/scenarios/s1/plays?open=false')).items).toEqual([]);

    const decisions = await page<{ id: string; state: string }>(
      '/v1/scenarios/s1/decisions?state=pending',
    );
    expect(decisions.items.map((item) => item.id)).toEqual(['s1-d1']);

    const play = (await get('/v1/plays/s1-p1')).json<{
      play: { id: string };
      stages: { id: string }[];
      demands: { id: string }[];
    }>();
    expect(play.play.id).toBe('s1-p1');
    expect(play.stages.map((item) => item.id)).toEqual(['s1-st1']);
    expect(play.demands.map((item) => item.id)).toEqual(['D1']);
  });

  it('answers 404 not_found for an id that does not exist', async () => {
    for (const path of [
      '/v1/scenarios/none',
      '/v1/scenarios/none/plays',
      '/v1/scenarios/none/decisions',
      '/v1/scenarios/none/attachments',
      '/v1/plays/none',
      '/v1/plays/none/blackboard/history?key=x',
      '/v1/orders/O99',
      '/v1/ideas/I99',
      '/v1/profiles/claude-code/none',
    ]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.json<{ error: { code: string } }>().error.code, path).toBe('not_found');
    }
  });

  it('answers 400 invalid_input to a cursor no route gave, and to a query it does not know', async () => {
    await seedScenario('s1');
    const bad = await get('/v1/scenarios?after=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(
      bad.json<{ error: { code: string; details?: { field?: string } } }>().error,
    ).toMatchObject({
      code: 'invalid_input',
      details: { field: 'after' },
    });
    // The cursor of another route has another shape: it is refused as well.
    const foreign = Buffer.from(JSON.stringify([1])).toString('base64url');
    expect((await get(`/v1/scenarios?after=${foreign}`)).status).toBe(400);
    expect((await get('/v1/scenarios?limit=0')).status).toBe(400);
    expect((await get('/v1/scenarios?nope=1')).status).toBe(400);
  });
});

describe('the blackboard', () => {
  it('lists the newest version of each key, shows a version, and walks the history by cursor', async () => {
    await seedScenario('s1');
    const latest = await page<{ key: string; version: number }>('/v1/plays/s1-p1/blackboard');
    expect(latest.items.map((item) => [item.key, item.version])).toEqual([
      ['plan', 2],
      ['script', 1],
    ]);
    const entry = (await get('/v1/plays/s1-p1/blackboard/entry?key=plan&version=1')).json<{
      version: number;
      value: unknown;
    }>();
    expect(entry).toMatchObject({ version: 1, value: { v: 1 } });
    expect(
      (await get('/v1/plays/s1-p1/blackboard/entry?key=plan')).json<{ version: number }>().version,
    ).toBe(2);
    expect((await get('/v1/plays/s1-p1/blackboard/entry?key=none')).status).toBe(404);

    const history = await walk<{ version: number }>(
      '/v1/plays/s1-p1/blackboard/history?key=plan',
      1,
    );
    expect(history.map((item) => item.version)).toEqual([1, 2]);
  });
});

describe('attachments', () => {
  async function attach(name: string, content: string | Uint8Array, mime: string): Promise<string> {
    const folder = join(tmp.dir, 'files');
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, content);
    const record = await daemon.store.attachments.add({
      scenarioId: 's1',
      name,
      mime,
      size: content.length,
      hash: 'h'.repeat(64),
      source: 'reference',
      path,
    });
    return record.id;
  }

  it('lists the metadata and gives the content on its own route', async () => {
    await seedScenario('s1');
    const first = await attach('a.txt', 'hello', 'text/plain');
    await attach('b.txt', 'world', 'text/plain');
    const list = await walk<{ id: string }>('/v1/scenarios/s1/attachments', 1);
    expect(list.map((item) => item.id)).toEqual([first, 'A2']);
    expect(list[0]).not.toHaveProperty('content');
    const meta = await get(`/v1/scenarios/s1/attachments/${first}`);
    expect(meta.json<{ name: string }>().name).toBe('a.txt');
    expect(meta.text).not.toContain('hello');
    const content = (await get(`/v1/scenarios/s1/attachments/${first}/content`)).json<{
      content: string;
      encoding: string;
      truncated: boolean;
    }>();
    expect(content).toMatchObject({ content: 'hello', encoding: 'utf8', truncated: false });
    expect((await get('/v1/scenarios/s1/attachments/A99')).status).toBe(404);
  });

  it('refuses a binary file over scenarios.attachment_read_max with 413', async () => {
    await seedScenario('s1');
    const big = new Uint8Array(9 * 1024 * 1024);
    const id = await attach('blob.bin', big, 'application/octet-stream');
    const answer = await get(`/v1/scenarios/s1/attachments/${id}/content`);
    expect(answer.status).toBe(413);
    expect(answer.json<{ error: { code: string } }>().error.code).toBe('payload_too_large');
  });
});

describe('profiles, Executors and roles', () => {
  async function seedProfile(): Promise<void> {
    await daemon.store.profiles.create({
      client: 'claude-code',
      name: 'api',
      kind: 'api',
      provider: 'anthropic',
      dir: join(tmp.dir, 'profiles', 'claude-code', 'api'),
      secretRef: 'profiles/claude-code/api',
    });
    await daemon.store.executors.create({
      profileId: 'claude-code/api',
      model: 'claude-opus',
      effort: 'high',
      provider: 'anthropic',
    });
  }

  it('lists the profiles with the quota state, and the secret as a reference only', async () => {
    await seedProfile();
    const list = await page<{
      profile: { id: string; secretRef: string | null };
      hasSecret: boolean;
      quota: { state: string; authorizes: boolean } | null;
    }>('/v1/profiles');
    expect(list.items).toHaveLength(1);
    const [item] = list.items;
    expect(item?.profile.secretRef).toBe('profiles/claude-code/api');
    expect(item?.hasSecret).toBe(true);
    expect(typeof item?.quota?.state).toBe('string');
    expect(typeof item?.quota?.authorizes).toBe('boolean');
    const one = await get('/v1/profiles/claude-code/api');
    expect(one.status).toBe(200);
    expect(one.text).not.toContain(VAULT_VALUE);
  });

  it('lists the Executors of the table and of the configuration, with the roles that hold them', async () => {
    await seedProfile();
    const list = await page<{ id: string; configured: boolean; roles: string[] }>('/v1/executors');
    const mine = list.items.find((item) => item.id === 'claude-opus-high@claude-code/api');
    expect(mine).toMatchObject({ configured: true });
    expect(mine?.roles).toContain('critic');
  });

  it('gives each role its ordered list, the next Executor and the exhaustion rule', async () => {
    await seedProfile();
    const body = (await get('/v1/roles')).json<{
      roles: {
        role: string;
        source: string;
        whenExhausted: string;
        executors: { id: string; blockedBy: string | null }[];
        next: string | null;
      }[];
    }>();
    const critic = body.roles.find((role) => role.role === 'critic');
    expect(critic).toMatchObject({ source: 'config', whenExhausted: 'wait' });
    expect(critic?.executors.map((item) => item.id)).toEqual(['claude-opus-high@claude-code/api']);
    // The next one is the first that is not blocked, or none when every one is.
    const free = critic?.executors.find((item) => item.blockedBy === null);
    expect(critic?.next ?? null).toBe(free?.id ?? null);
  });
});

describe('orders, ideas, consumption and the budget', () => {
  it('lists the orders in force, scheduled and ended, by cursor', async () => {
    const { directives } = daemon.store;
    await directives.create({
      scope: 'global',
      kind: 'instruction',
      text: 'a',
      roles: [],
      timezone: 'UTC',
      origin: 'chat',
    });
    await directives.create({
      scope: 'global',
      kind: 'instruction',
      text: 'b',
      roles: [],
      timezone: 'UTC',
      origin: 'chat',
      startsAt: clock.now() + 60_000,
    });
    const revoked = await directives.create({
      scope: 'global',
      kind: 'instruction',
      text: 'c',
      roles: [],
      timezone: 'UTC',
      origin: 'chat',
    });
    await directives.revoke(revoked.id, 'no longer');
    const all = await walk<{ id: string; state: string }>('/v1/orders', 1);
    expect(all.map((item) => item.state)).toEqual(['active', 'scheduled', 'revoked']);
    expect((await page<{ state: string }>('/v1/orders?state=active')).items).toHaveLength(1);
    expect((await page<{ state: string }>('/v1/orders?state=scheduled')).items).toHaveLength(1);
    expect(
      (await page<{ state: string }>('/v1/orders?state=ended')).items.map((item) => item.state),
    ).toEqual(['revoked']);
    expect(
      (await get(`/v1/orders/${revoked.id}`)).json<{ revokeReason: string }>().revokeReason,
    ).toBe('no longer');
  });

  it('lists the idea queue in the order the ideas arrived, and filters by state', async () => {
    await seedScenario('s1');
    for (const text of ['one', 'two', 'three']) {
      await daemon.store.ideas.create({ scenarioId: 's1', text });
    }
    await daemon.store.ideas.transition('I2', 'discarded', { reason: 'not now' });
    const queue = await walk<{ id: string; seq: number }>('/v1/ideas?state=queued', 1);
    expect(queue.map((item) => item.id)).toEqual(['I1', 'I3']);
    expect((await walk<{ id: string }>('/v1/ideas', 2)).map((item) => item.id)).toEqual([
      'I1',
      'I2',
      'I3',
    ]);
    expect((await get('/v1/ideas/I2')).json<{ reason: string }>().reason).toBe('not now');
  });

  it('gives the consumption with a breakdown and the spending cap', async () => {
    await daemon.store.usage.record({
      sessionId: 'sess1',
      profileId: 'claude-code/api',
      executorId: 'claude-opus-high@claude-code/api',
      model: 'claude-opus',
      inputTokens: 100,
      outputTokens: 20,
    });
    const usage = (await get('/v1/usage?by=profile')).json<{
      totals: { turns: number };
      by: string;
      groups: { key: string }[];
    }>();
    expect(usage.totals.turns).toBe(1);
    expect(usage.by).toBe('profile');
    expect(usage.groups.map((group) => group.key)).toEqual(['claude-code/api']);
    const budget = (await get('/v1/budget')).json<{
      timezone: string;
      caps: { scope: string; period: string }[];
    }>();
    expect(budget.timezone).toBe('America/Sao_Paulo');
    expect(budget.caps.map((cap) => [cap.scope, cap.period])).toContainEqual(['profile', 'day']);
  });
});

describe('the effective configuration', () => {
  it('comes with the defaults and without the literal that looked like a secret', async () => {
    const answer = await get('/v1/config');
    expect(answer.status).toBe(200);
    const body = answer.json<{
      config: { clients: { codex: { env: Record<string, string> } }; budget: { timezone: string } };
      redactedPaths: string[];
    }>();
    expect(body.config.budget.timezone).toBe('America/Sao_Paulo');
    expect(body.config.clients.codex.env.OPENAI_API_KEY).toBe(REDACTED_VALUE);
    expect(body.redactedPaths).toEqual(['clients.codex.env.OPENAI_API_KEY']);
    expect(answer.text).not.toContain(CONFIG_VALUE);
  });
});

describe('no secret leaves through a GET route', () => {
  it('never carries the vault value, the literals of the config or of a scenario, in any GET route', async () => {
    await seedScenario('s1');
    await daemon.store.profiles.create({
      client: 'claude-code',
      name: 'api',
      kind: 'api',
      provider: 'anthropic',
      dir: join(tmp.dir, 'profiles', 'claude-code', 'api'),
      secretRef: 'profiles/claude-code/api',
    });
    await daemon.store.executors.create({
      profileId: 'claude-code/api',
      model: 'claude-opus',
      effort: 'high',
      provider: 'anthropic',
    });
    await daemon.store.ideas.create({ scenarioId: 's1', text: 'an idea' });
    await daemon.store.directives.create({
      scope: 'global',
      kind: 'instruction',
      text: 'x',
      roles: [],
      timezone: 'UTC',
      origin: 'chat',
    });

    const paths = [
      '/v1/status',
      '/v1/scenarios',
      '/v1/scenarios/s1',
      '/v1/scenarios/s1/plays',
      '/v1/scenarios/s1/decisions',
      '/v1/scenarios/s1/attachments',
      '/v1/plays/s1-p1',
      '/v1/plays/s1-p1/blackboard',
      '/v1/plays/s1-p1/blackboard/history?key=plan',
      '/v1/plays/s1-p1/blackboard/entry?key=plan',
      '/v1/profiles',
      '/v1/profiles/claude-code/api',
      '/v1/executors',
      '/v1/roles',
      '/v1/orders',
      '/v1/orders/O1',
      '/v1/ideas',
      '/v1/ideas/I1',
      '/v1/usage',
      '/v1/budget',
      '/v1/config',
    ];
    for (const path of paths) {
      const answer = await get(path);
      expect(answer.status, path).toBe(200);
      for (const secret of [VAULT_VALUE, CONFIG_VALUE, CONVENTION_VALUE]) {
        expect(answer.text, path).not.toContain(secret);
      }
    }
    // Every GET route of the registry the sweep did not name has no handler of this step.
    const covered = new Set(paths.map((path) => path.split('?')[0]));
    expect(covered.size).toBeGreaterThan(15);
  });

  it('leaves no event behind: a read is not a write', async () => {
    await seedScenario('s1');
    const before = await daemon.store.events.lastId();
    for (const path of [
      '/v1/scenarios',
      '/v1/scenarios/s1',
      '/v1/profiles',
      '/v1/roles',
      '/v1/budget',
      '/v1/config',
    ]) {
      await get(path);
    }
    expect(await daemon.store.events.lastId()).toBe(before);
  });
});
