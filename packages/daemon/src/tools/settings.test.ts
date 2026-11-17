// SPDX-License-Identifier: MPL-2.0
import type { JsonObject, NewScenario } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { ToolFailure } from '../mcp/handlers.js';
import {
  commandArgv,
  configuredCommand,
  conventionCommandsOf,
  profileCommands,
  resolveToolSettings,
  toolsOverrideOf,
  type ToolSettings,
} from './settings.js';

const base = parseConfig('tools:\n  commands:\n    test: pnpm test\n').tools;

type ScenarioSpec = Partial<NewScenario> & { id: string };

async function storeWith(scenarios: readonly ScenarioSpec[]): Promise<InMemoryStore> {
  const store = new InMemoryStore({ clock: new FakeClock(1_000) });
  for (const scenario of scenarios) {
    await store.scenarios.create({
      kind: 'project',
      flowId: 'play.default',
      name: scenario.id,
      folder: `/work/${scenario.id}`,
      ...scenario,
    });
  }
  return store;
}

async function withPlay(store: InMemoryStore, scenarioId: string): Promise<void> {
  await store.plays.create({
    id: 'p1',
    scenarioId,
    need: 'need',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
}

describe('toolsOverrideOf', () => {
  it('takes a nested tools object and dotted keys, the dotted key winning', () => {
    expect(
      toolsOverrideOf({
        tools: { timeout_ms: 1000, shell_allowlist: { mode: 'any' } },
        'tools.timeout_ms': 2000,
        'tools.http.redirects': 'follow_allowed',
        'other.key': 1,
      }),
    ).toEqual({
      timeout_ms: 2000,
      shell_allowlist: { mode: 'any' },
      http: { redirects: 'follow_allowed' },
    });
  });

  it('is empty for an override with nothing of tools', () => {
    expect(toolsOverrideOf({})).toEqual({});
    expect(toolsOverrideOf({ 'limits.submit_retries': 3 })).toEqual({});
  });

  it('refuses an unknown key, a wrong type and the env keys, with invalid_config', () => {
    const overrides: JsonObject[] = [
      { 'tools.nope': 1 },
      { tools: { timeout_ms: 'soon' } },
      { tools: 'text' },
      { 'tools.env_inherit': 'all' },
      { 'tools.env_allow': ['SECRET'] },
    ];
    for (const override of overrides) {
      try {
        toolsOverrideOf(override);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ToolFailure);
        expect((error as ToolFailure).code).toBe('invalid_config');
      }
    }
  });
});

describe('conventionCommandsOf and commandArgv', () => {
  it('reads commands as lines or argvs and ignores what is not a command', () => {
    expect(
      conventionCommandsOf({
        commands: { test: 'pnpm vitest run', lint: ['eslint', '.'], bad: 7, worse: [] },
      }),
    ).toEqual({ test: 'pnpm vitest run', lint: ['eslint', '.'] });
    expect(conventionCommandsOf(null)).toEqual({});
    expect(conventionCommandsOf({ commands: 'nope' })).toEqual({});
  });

  it('splits a line without a shell and keeps an argv as it is', () => {
    expect(commandArgv('node -e "a b"')).toEqual(['node', '-e', 'a b']);
    expect(commandArgv(['pnpm', 'install'])).toEqual(['pnpm', 'install']);
  });
});

describe('resolveToolSettings', () => {
  it('gives the global block when the call has no play or the scenario has no override', async () => {
    const store = await storeWith([{ id: 's1' }]);
    const none = await resolveToolSettings(base, store, 'a1', undefined);
    expect(none.config).toEqual(base);
    expect(none.scenarioId).toBeUndefined();
    await withPlay(store, 's1');
    const plain = await resolveToolSettings(base, store, 'a1', 'p1');
    expect(plain.config).toEqual(base);
    expect(plain.scenarioId).toBe('s1');
  });

  it('puts the override of the scenario over the global block, key by key', async () => {
    const store = await storeWith([
      {
        id: 's1',
        configOverride: { 'tools.timeout_ms': 5000, 'tools.shell_allowlist.mode': 'profile' },
      },
    ]);
    await withPlay(store, 's1');
    const settings = await resolveToolSettings(base, store, 'a1', 'p1');
    expect(settings.config.timeout_ms).toBe(5000);
    expect(settings.config.shell_allowlist.mode).toBe('profile');
    // The list of the global block stays: only the mode was overridden.
    expect(settings.config.shell_allowlist.list).toEqual(base.shell_allowlist.list);
    expect(settings.config.output_max_bytes).toBe(base.output_max_bytes);
  });

  it('layers the scenario a chat was promoted from under the own scenario', async () => {
    const store = await storeWith([
      {
        id: 'origin',
        configOverride: { tools: { timeout_ms: 1000, output_max_bytes: 111 } },
        conventions: { commands: { test: 'origin test', install: 'origin install' } },
      },
      {
        id: 'own',
        originScenarioId: 'origin',
        configOverride: { tools: { timeout_ms: 2000 } },
        conventions: { commands: { test: 'own test' } },
      },
    ]);
    await withPlay(store, 'own');
    const settings = await resolveToolSettings(base, store, 'a1', 'p1');
    expect(settings.config.timeout_ms).toBe(2000);
    expect(settings.config.output_max_bytes).toBe(111);
    expect(settings.conventionCommands).toEqual({ test: 'own test', install: 'origin install' });
  });

  it('refuses a broken override instead of falling back to a wider limit', async () => {
    const store = await storeWith([{ id: 's1', configOverride: { 'tools.timeout_ms': 0 } }]);
    await withPlay(store, 's1');
    await expect(resolveToolSettings(base, store, 'a1', 'p1')).rejects.toMatchObject({
      code: 'invalid_config',
    });
  });

  it('finds the play through the attempt when the call carries no correlation', async () => {
    const store = await storeWith([{ id: 's1', configOverride: { 'tools.timeout_ms': 7000 } }]);
    await withPlay(store, 's1');
    await store.attempts.put({
      attemptId: 'a1',
      playId: 'p1',
      demandId: 'd1',
      attempt: 1,
      client: 'fake',
      profile: 'one',
      state: 'executing',
      cause: null,
      sessionId: null,
      worktree: '/wt',
      branch: 'b',
      lastCheckpoint: null,
      lastCheckpointAt: null,
      lastEventAt: null,
      resumes: 0,
      freeResumes: 0,
    });
    expect((await resolveToolSettings(base, store, 'a1', undefined)).config.timeout_ms).toBe(7000);
  });
});

describe('configuredCommand and profileCommands', () => {
  async function settingsOf(scenario: Partial<NewScenario>): Promise<ToolSettings> {
    const store = await storeWith([{ id: 's1', ...scenario }]);
    await withPlay(store, 's1');
    return await resolveToolSettings(base, store, 'a1', 'p1');
  }

  it('chooses override, then conventions, then global', async () => {
    const globalOnly = await settingsOf({});
    expect(configuredCommand(globalOnly, 'test')).toEqual(['pnpm', 'test']);
    expect(configuredCommand(globalOnly, 'install')).toBeUndefined();

    const withConventions = await settingsOf({
      conventions: { commands: { test: 'make test', install: 'make deps' } },
    });
    expect(configuredCommand(withConventions, 'test')).toEqual(['make', 'test']);
    expect(configuredCommand(withConventions, 'install')).toEqual(['make', 'deps']);

    const overridden = await settingsOf({
      conventions: { commands: { test: 'make test' } },
      configOverride: { 'tools.commands.test': ['just', 'test'] },
    });
    expect(configuredCommand(overridden, 'test')).toEqual(['just', 'test']);
  });

  it('lists every command of the project for the mode profile', async () => {
    const settings = await settingsOf({
      conventions: { commands: { lint: 'eslint .', build: ['tsc', '-b'] } },
    });
    expect(profileCommands(settings)).toEqual(
      expect.arrayContaining([
        ['eslint', '.'],
        ['tsc', '-b'],
        ['pnpm', 'test'],
      ]),
    );
  });
});
