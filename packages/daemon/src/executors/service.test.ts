// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Conflict, InvalidInput, NotFound, type ModelCatalog } from '@otheater/core';
import { FakeClock, FakeModelCatalog, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { fixtureOpenCodeCatalog, OPENCODE_VERBOSE_OUTPUT } from './opencode-catalog-fixture.js';
import { ExecutorService, REMOVED_REASON, type AddExecutorResult } from './service.js';
import type { TestSession } from './test-session.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const PROFILE = 'opencode/local';
const MINIMAX = 'minimax/MiniMax-M2';
const MINIMAX_ID = 'minimax-m2-medium@opencode/local';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Rig {
  readonly service: ExecutorService;
  readonly store: InMemoryStore;
  readonly dir: string;
  readonly configPath: string;
  readonly launched: () => number;
  config(): ReturnType<typeof loadConfig>;
  text(): Promise<string>;
  withCatalogs(catalogs: Record<string, ModelCatalog>): ExecutorService;
}

async function setup(
  configYaml = '',
  options: { testSession?: TestSession; catalog?: ModelCatalog } = {},
): Promise<Rig> {
  const dir = await makeTempDataDir();
  cleanups.push(dir.dispose);
  const configPath = join(dir.dir, 'config.yaml');
  if (configYaml !== '') await writeFile(configPath, configYaml);
  const store = new InMemoryStore({ clock: new FakeClock(T0) });
  for (const [client, name] of [
    ['opencode', 'local'],
    ['claude-code', 'main'],
  ] as const) {
    await store.profiles.create({
      client,
      name,
      kind: 'token_plan',
      provider: client === 'claude-code' ? 'anthropic' : 'minimax',
      dir: `/profiles/${client}/${name}`,
      secretRef: null,
    });
  }
  const opencode = fixtureOpenCodeCatalog({ profileRoot: join(dir.dir, 'profiles') });
  const catalogs: Record<string, ModelCatalog> = {
    opencode: options.catalog ?? opencode.catalog,
    'claude-code': new FakeModelCatalog(),
  };
  const make = (map: Record<string, ModelCatalog>): ExecutorService =>
    new ExecutorService({
      store,
      clock: new FakeClock(T0),
      logger: createSilentLogger(),
      configPath,
      catalogs: (client) => map[client],
      testSession: options.testSession,
    });
  return {
    service: make(catalogs),
    store,
    dir: dir.dir,
    configPath,
    launched: () => opencode.launcher.launched.length,
    config: () => loadConfig(configPath),
    text: () => readFile(configPath, 'utf8'),
    withCatalogs: (map) => make({ ...catalogs, ...map }),
  };
}

function registered(result: AddExecutorResult) {
  if (result.status !== 'registered') {
    throw new Error(`expected registered, got ${result.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

describe('the cadastro pre-fills the fields from the OpenCode catalog', () => {
  it('lists the models with name, effort, provider, context and tool calls filled', async () => {
    const rig = await setup();
    const models = await rig.service.models(PROFILE);
    const minimax = models.find((item) => item.info.id === MINIMAX);
    expect(minimax?.draft).toMatchObject({
      model: MINIMAX,
      alias: 'minimax-m2',
      effort: 'medium',
      efforts: ['low', 'medium', 'high'],
      provider: 'minimax',
      local: false,
      contextWindow: 200000,
      reasoning: true,
      toolCalls: true,
      cost: { inputPerMTokUsd: 0.3, outputPerMTokUsd: 1.2 },
    });
    // The command that lists the models is the (fake) launcher's: the real `opencode` never runs.
    expect(rig.launched()).toBeGreaterThan(0);
  });

  it('registers with those fields: config entry, table row and the cost in the result', async () => {
    const rig = await setup();
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.executor).toMatchObject({
      id: MINIMAX_ID,
      model: MINIMAX,
      effort: 'medium',
      provider: 'minimax',
      validity: 'valid',
    });
    expect(result.cost).toEqual({ inputPerMTokUsd: 0.3, outputPerMTokUsd: 1.2 });
    expect(result.localBlock).toBe('none');

    const config = await rig.config();
    expect(config.executors.entries[MINIMAX_ID]).toEqual({
      id: MINIMAX_ID,
      client: 'opencode',
      profile: 'local',
      model: MINIMAX,
      effort: 'medium',
      provider: 'minimax',
    });
    const row = await rig.store.executors.get(MINIMAX_ID);
    expect(row).toMatchObject({
      profileId: PROFILE,
      model: 'minimax-m2',
      effort: 'medium',
      validity: 'valid',
    });
  });

  it('--dry-run reports the same and writes nothing', async () => {
    const rig = await setup();
    const result = await rig.service.add({ profileId: PROFILE, model: MINIMAX, dryRun: true });
    expect(result.status).toBe('dry_run');
    await expect(rig.text()).rejects.toThrow(/ENOENT/);
    expect(await rig.store.executors.list()).toHaveLength(0);
  });

  it('refuses a model the catalog does not list, with the near ones', async () => {
    const rig = await setup();
    const result = await rig.service.add({ profileId: PROFILE, model: 'minimax/MiniMax-M3' });
    expect(result).toMatchObject({ status: 'refused', draft: null });
    const near = await rig.service.add({ profileId: PROFILE, model: 'MiniMax-M2' });
    expect(near.status).toBe('refused');
  });
});

describe('a model whose catalog gives no family', () => {
  const MYSTERY = 'gateway/mystery-model';

  it('leaves the provider blank and asks for the field, writing nothing', async () => {
    const rig = await setup();
    const result = await rig.service.add({ profileId: PROFILE, model: MYSTERY });
    expect(result.status).toBe('needs_input');
    if (result.status !== 'needs_input') return;
    expect(result.missing).toEqual(['family']);
    expect(result.draft.provider).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('family_required');
    await expect(rig.text()).rejects.toThrow(/ENOENT/);
    expect(await rig.store.executors.list()).toHaveLength(0);
  });

  it('registers once the family is given, and the family is the provider', async () => {
    const rig = await setup();
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: MYSTERY, family: 'mystery' }),
    );
    expect(result.executor.provider).toBe('mystery');
    const entry = (await rig.config()).executors.entries[result.executor.id];
    expect(entry?.provider).toBe('mystery');
  });
});

describe('the capability check of the model', () => {
  it('refuses a model that does not call tools, naming the reason', async () => {
    const rig = await setup();
    const result = await rig.service.add({ profileId: PROFILE, model: 'local/completion-only' });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'no_tool_calls', severity: 'error' }),
    );
    expect(await rig.store.executors.list()).toHaveLength(0);
  });

  it('refuses an effort the model does not accept', async () => {
    const rig = await setup();
    const result = await rig.service.add({
      profileId: PROFILE,
      model: 'gateway/mystery-model',
      family: 'mystery',
      effort: 'high',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.issues.map((issue) => issue.code)).toContain('effort_not_accepted');
  });

  it('refuses an effort that is not low, medium or high before anything else', async () => {
    const rig = await setup();
    await expect(
      rig.service.add({ profileId: PROFILE, model: MINIMAX, effort: 'max' }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('refuses a profile that does not exist', async () => {
    const rig = await setup();
    await expect(
      rig.service.add({ profileId: 'opencode/other', model: MINIMAX }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});

describe('a local model', () => {
  it('creates the local block of the profile from the catalog URL', async () => {
    const rig = await setup('# the producer notes\nbackup:\n  when: manual\n');
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: 'local/qwen-coder', effort: undefined }),
    );
    expect(result.localBlock).toBe('created');
    const config = await rig.config();
    expect(config.profiles.entries[PROFILE]?.local).toEqual({
      server: 'llama-cpp',
      url: 'http://127.0.0.1:8080/v1',
      slots: 'auto',
      reserve_for_director: 1,
      reserve_when: 'listed',
    });
    // What the Producer wrote stays where it was.
    const text = await rig.text();
    expect(text).toContain('# the producer notes');
    expect(text).toContain('when: manual');
  });

  it('keeps the local block that already exists', async () => {
    const rig = await setup(
      `profiles:\n  ${PROFILE}:\n    local:\n      server: ollama\n      url: http://localhost:11434\n`,
    );
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: 'local/qwen-coder' }),
    );
    expect(result.localBlock).toBe('kept');
    expect((await rig.config()).profiles.entries[PROFILE]?.local?.server).toBe('ollama');
  });

  it('asks for the URL when the catalog says local but gives none, and takes --local-server', async () => {
    const rig = await setup();
    // OpenCode derives "local" from the URL, so this is a catalog that knows less: it says local, no URL.
    const inner = fixtureOpenCodeCatalog({ profileRoot: join(rig.dir, 'profiles') }).catalog;
    const blind: ModelCatalog = {
      discovery: inner.discovery,
      list: async (ref) =>
        (await inner.list(ref)).map((info) => {
          if (info.id !== 'local/qwen-coder') return info;
          const rest = { ...info };
          delete rest.baseUrl;
          return rest;
        }),
      validate: (executor) => inner.validate(executor),
      suggest: (info) => inner.suggest(info),
    };
    const service = rig.withCatalogs({ opencode: blind });
    const asked = await service.add({ profileId: PROFILE, model: 'local/qwen-coder' });
    expect(asked.status).toBe('needs_input');
    if (asked.status !== 'needs_input') return;
    expect(asked.missing).toEqual(['local_url']);
    await expect(rig.text()).rejects.toThrow(/ENOENT/);

    const result = registered(
      await service.add({
        profileId: PROFILE,
        model: 'local/qwen-coder',
        localUrl: 'http://localhost:11434',
        localServer: 'ollama',
      }),
    );
    expect(result.localBlock).toBe('created');
    expect((await rig.config()).profiles.entries[PROFILE]?.local).toMatchObject({
      server: 'ollama',
      url: 'http://localhost:11434',
    });
  });

  it('does not write a local block for a model that does not run here', async () => {
    const rig = await setup();
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect((await rig.config()).profiles.entries[PROFILE]).toBeUndefined();
  });
});

describe('executors.on_register', () => {
  const OTHER = 'claude-sonnet-medium@claude-code/main';
  const base = (mode: string): string => `
executors:
  on_register: ${mode}
  ${OTHER}:
    client: claude-code
    profile: main
    model: fake-model
    effort: medium
roles:
  author:
    executors: [${OTHER}]
  actor:
    executors: [${OTHER}]
`;

  it('preset_only puts the Executor only where the preset cites it', async () => {
    const rig = await setup(base('preset_only'));
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    // `minimax-m2-medium` is in the actor of the three presets and in no other role.
    expect(result.placements.map((placement) => placement.role)).toEqual(['actor']);
    const config = await rig.config();
    expect(config.roles.actor?.executors).toEqual([OTHER, MINIMAX_ID]);
    expect(config.roles.author?.executors).toEqual([OTHER]);
    expect(result.executor.roles).toEqual(['actor']);
  });

  it('ask writes only the Executor and offers the roles, the preset one marked', async () => {
    const rig = await setup(base('ask'));
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.placements).toEqual([]);
    expect(result.options.find((option) => option.role === 'actor')?.preselected).toBe(true);
    expect(result.options.find((option) => option.role === 'author')?.preselected).toBe(false);
    const config = await rig.config();
    expect(config.roles.actor?.executors).toEqual([OTHER]);
    expect(config.executors.entries[MINIMAX_ID]).toBeDefined();
  });

  it('none changes no list', async () => {
    const rig = await setup(base('none'));
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.placements).toEqual([]);
    expect(result.options).toEqual([]);
    expect((await rig.config()).roles.actor?.executors).toEqual([OTHER]);
  });

  it('none also keeps it out of the expansion of the presets (N136)', async () => {
    const rig = await setup(`executors:\n  on_register: none\n`);
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    const config = await rig.config();
    expect(config.executors.entries[MINIMAX_ID]?.presetExpand).toBe(false);
    expect(result.executor.roles).toEqual([]);
    expect(await rig.service.list()).toMatchObject([{ id: MINIMAX_ID, roles: [] }]);
  });

  it('ask and preset_only leave preset_expand out, and the preset still reaches the Executor', async () => {
    for (const mode of ['ask', 'preset_only']) {
      const rig = await setup(`executors:\n  on_register: ${mode}\n`);
      const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
      expect((await rig.config()).executors.entries[MINIMAX_ID]?.presetExpand).toBeUndefined();
      expect(result.executor.roles).toContain('actor');
    }
  });

  it('none with --role: it enters only the role the Producer named', async () => {
    const rig = await setup(`executors:\n  on_register: none\n`);
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: MINIMAX, roles: [{ role: 'critic' }] }),
    );
    expect(result.executor.roles).toEqual(['critic']);
    expect((await rig.config()).executors.entries[MINIMAX_ID]?.presetExpand).toBe(false);
  });

  it('--role puts it where the Producer says, whatever the mode', async () => {
    const rig = await setup(base('ask'));
    const result = registered(
      await rig.service.add({
        profileId: PROFILE,
        model: MINIMAX,
        roles: [{ role: 'author', position: 0 }],
      }),
    );
    expect(result.placements).toEqual([{ role: 'author', via: 'list', position: 0, inList: true }]);
    expect((await rig.config()).roles.author?.executors).toEqual([MINIMAX_ID, OTHER]);
  });

  it('--role on a role with no list of its own copies the preset list first', async () => {
    const rig = await setup(`executors:\n  on_register: none\n`);
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: MINIMAX, roles: [{ role: 'critic' }] }),
    );
    const config = await rig.config();
    expect(config.roles.critic?.executors).toEqual([MINIMAX_ID]);
    expect(result.executor.roles).toContain('critic');
  });
});

describe('roles.capability_check on a role the model is below', () => {
  const SMALL = 'minimax/small-context';
  const yaml = (mode: string): string => `
executors:
  on_register: none
roles:
  capability_check: ${mode}
`;

  it('warn registers and reports the shortfall', async () => {
    const rig = await setup(yaml('warn'));
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: SMALL, roles: [{ role: 'author' }] }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'below_minimum', severity: 'warning' }),
    );
  });

  it('block refuses a role the model is below and writes nothing', async () => {
    const rig = await setup(yaml('block'));
    const result = await rig.service.add({
      profileId: PROFILE,
      model: SMALL,
      roles: [{ role: 'author' }],
    });
    expect(result.status).toBe('refused');
    expect(await rig.store.executors.list()).toHaveLength(0);
  });

  it('off does not check', async () => {
    const rig = await setup(yaml('off'));
    const result = registered(
      await rig.service.add({ profileId: PROFILE, model: SMALL, roles: [{ role: 'author' }] }),
    );
    expect(result.issues.map((issue) => issue.code)).not.toContain('below_minimum');
  });
});

describe('the short test session', () => {
  const session = (ok: boolean): { session: TestSession; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      session: {
        run: (request) => {
          calls.push(`${request.executorId}|${request.model}|${request.profile.id}`);
          return Promise.resolve({ ok, detail: ok ? 'it submitted' : 'no tool call' });
        },
      },
    };
  };

  it('is off by default: the model is not called', async () => {
    const fake = session(true);
    const rig = await setup('', { testSession: fake.session });
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.testSession).toBe('skipped');
    expect(fake.calls).toEqual([]);
  });

  it('approves: runs with the real model id and registers', async () => {
    const fake = session(true);
    const rig = await setup('executors:\n  test_session: run\n', { testSession: fake.session });
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.testSession).toBe('approved');
    expect(fake.calls).toEqual([`${MINIMAX_ID}|${MINIMAX}|${PROFILE}`]);
  });

  it('--test-session asks for it when the key is off, and --no-test-session skips it', async () => {
    const fake = session(true);
    const rig = await setup('', { testSession: fake.session });
    const on = registered(
      await rig.service.add({ profileId: PROFILE, model: MINIMAX, testSession: 'run' }),
    );
    expect(on.testSession).toBe('approved');
    const rig2 = await setup('executors:\n  test_session: run\n', { testSession: fake.session });
    const off = registered(
      await rig2.service.add({ profileId: PROFILE, model: MINIMAX, testSession: 'off' }),
    );
    expect(off.testSession).toBe('skipped');
  });

  it('fails: registers with a warning under capability_check warn', async () => {
    const fake = session(false);
    const rig = await setup('executors:\n  test_session: run\n', { testSession: fake.session });
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.testSession).toBe('failed');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'test_session_failed', severity: 'warning' }),
    );
  });

  it('fails: refuses and writes nothing under capability_check block', async () => {
    const fake = session(false);
    const rig = await setup(
      'executors:\n  test_session: run\nroles:\n  capability_check: block\n',
      {
        testSession: fake.session,
      },
    );
    const result = await rig.service.add({ profileId: PROFILE, model: MINIMAX });
    expect(result.status).toBe('refused');
    await expect(
      rig.config().then((config) => config.executors.entries[MINIMAX_ID]),
    ).resolves.toBeUndefined();
    expect(await rig.store.executors.list()).toHaveLength(0);
  });

  it('a session that throws is a failed one', async () => {
    const rig = await setup('executors:\n  test_session: run\n', {
      testSession: { run: () => Promise.reject(new Error('boom')) },
    });
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.testSession).toBe('failed');
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('boom');
  });

  it('without a way to run it, only warns', async () => {
    const rig = await setup('executors:\n  test_session: run\n');
    const result = registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(result.testSession).toBe('skipped');
    expect(result.issues.map((issue) => issue.code)).toContain('test_session_unavailable');
  });
});

describe('list, check and remove', () => {
  it('refuses a second cadastro of the same Executor', async () => {
    const rig = await setup();
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    await expect(rig.service.add({ profileId: PROFILE, model: MINIMAX })).rejects.toBeInstanceOf(
      Conflict,
    );
  });

  it('lists what was registered, with the roles that hold it', async () => {
    const rig = await setup();
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    const list = await rig.service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: MINIMAX_ID, validity: 'valid', configured: true });
    // The preset of the actor cites it, so the role holds it with no line in the file.
    expect(list[0]?.roles).toContain('actor');
    expect(await rig.service.list({ profileId: 'claude-code/main' })).toEqual([]);
  });

  it('check marks an Executor invalid when the catalog stops accepting the model', async () => {
    const rig = await setup();
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(await rig.service.check()).toEqual([
      expect.objectContaining({ id: MINIMAX_ID, validity: 'valid', changed: false }),
    ]);

    const gone = fixtureOpenCodeCatalog({
      profileRoot: join(rig.dir, 'profiles'),
      stdout: OPENCODE_VERBOSE_OUTPUT.replaceAll('minimax/MiniMax-M2', 'minimax/MiniMax-M2-gone'),
    });
    const later = rig.withCatalogs({ opencode: gone.catalog });
    const [checked] = await later.check();
    expect(checked).toMatchObject({
      id: MINIMAX_ID,
      validity: 'invalid',
      reason: 'model_unknown',
      changed: true,
    });
    expect(await rig.store.executors.get(MINIMAX_ID)).toMatchObject({
      validity: 'invalid',
      invalidReason: 'model_unknown',
    });
    // And back to valid when the model returns.
    const [again] = await rig.service.check(MINIMAX_ID);
    expect(again).toMatchObject({ validity: 'valid', changed: true });
  });

  it('check leaves the row alone when the client is not there to answer', async () => {
    const rig = await setup();
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    const blind = rig.withCatalogs({});
    const noClient = new ExecutorService({
      store: rig.store,
      clock: new FakeClock(T0),
      logger: createSilentLogger(),
      configPath: rig.configPath,
      catalogs: () => undefined,
    });
    expect(blind).toBeDefined();
    const [checked] = await noClient.check();
    expect(checked).toMatchObject({
      validity: 'unchecked',
      reason: 'client_unavailable',
      changed: false,
    });
    expect(await rig.store.executors.get(MINIMAX_ID)).toMatchObject({ validity: 'valid' });
  });

  it('check of an unknown id is NotFound', async () => {
    const rig = await setup();
    await expect(rig.service.check('nope-high@opencode/local')).rejects.toBeInstanceOf(NotFound);
  });

  it('remove takes it out of the entries and of every list, and the row stays as removed', async () => {
    const rig = await setup(`executors:\n  on_register: none\n`);
    registered(
      await rig.service.add({
        profileId: PROFILE,
        model: MINIMAX,
        roles: [{ role: 'critic' }],
      }),
    );
    expect((await rig.config()).roles.critic?.executors).toEqual([MINIMAX_ID]);

    const result = await rig.service.remove(MINIMAX_ID);
    expect(result).toMatchObject({
      id: MINIMAX_ID,
      rolesChanged: ['critic'],
      rolesEmptied: ['critic'],
      inConfig: true,
    });
    const config = await rig.config();
    expect(config.executors.entries[MINIMAX_ID]).toBeUndefined();
    expect(config.roles.critic?.executors).toBeUndefined();
    expect(await rig.store.executors.get(MINIMAX_ID)).toMatchObject({
      validity: 'invalid',
      invalidReason: REMOVED_REASON,
    });
    expect(await rig.service.list()).toEqual([]);
    expect(await rig.service.list({ all: true })).toHaveLength(1);
    await expect(rig.service.remove(MINIMAX_ID)).rejects.toBeInstanceOf(NotFound);

    // It can be registered again: the row comes back valid.
    registered(await rig.service.add({ profileId: PROFILE, model: MINIMAX }));
    expect(await rig.store.executors.get(MINIMAX_ID)).toMatchObject({ validity: 'valid' });
  });

  it('executor.changed: the register and the removal are events, with the roles they touched (P24, N146)', async () => {
    const rig = await setup(`executors:\n  on_register: none\n`);
    registered(
      await rig.service.add({ profileId: PROFILE, model: MINIMAX, roles: [{ role: 'critic' }] }),
    );
    await rig.service.remove(MINIMAX_ID);
    const changed = (await rig.store.events.readFrom(0, 100)).filter(
      (event) => event.type === 'executor.changed',
    );
    expect(changed.map((event) => event.payload)).toEqual([
      { executorId: MINIMAX_ID, change: 'registered', profile: PROFILE, roles: ['critic'] },
      { executorId: MINIMAX_ID, change: 'removed', profile: PROFILE, roles: ['critic'] },
    ]);
  });

  it('a dry run and a refused cadastro write no executor.changed', async () => {
    const rig = await setup();
    await rig.service.add({ profileId: PROFILE, model: MINIMAX, dryRun: true });
    await rig.service
      .add({ profileId: PROFILE, model: 'minimax/not-there' })
      .catch(() => undefined);
    expect(
      (await rig.store.events.readFrom(0, 100)).filter(
        (event) => event.type === 'executor.changed',
      ),
    ).toEqual([]);
  });
});
