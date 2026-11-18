// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  type ExecutorEntry,
  type ProfileFact,
  type ScenarioRecord,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import {
  deprecationWarnings,
  executorCatalogOf,
  legacyExecutorsOf,
  resolveScenarioRoleExecutors,
} from './role-executors.js';

function scenario(id: string, patch: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return {
    id,
    kind: 'project',
    flowId: 'play',
    name: id,
    folder: '/work',
    profile: null,
    conventions: null,
    baseBranch: null,
    configOverride: {},
    originScenarioId: null,
    directorState: 'active',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function resolver(yaml = '', records: readonly ScenarioRecord[] = []) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return {
    config: parseConfig(yaml),
    scenarios: { get: (id: string) => Promise.resolve(byId.get(id)) },
  };
}

const entry = (
  id: string,
  client: string,
  profile: string,
  model: string,
  effort: ExecutorEntry['effort'],
  provider: string,
): ExecutorEntry => ({ id, client, profile, model, effort, provider });

const discovered: ExecutorEntry[] = [
  entry(
    'claude-opus-high@claude-code/empresa',
    'claude-code',
    'empresa',
    'claude-opus',
    'high',
    'anthropic',
  ),
  entry(
    'claude-sonnet-medium@claude-code/empresa',
    'claude-code',
    'empresa',
    'claude-sonnet',
    'medium',
    'anthropic',
  ),
  entry('codex-sol-high@codex/conta-1', 'codex', 'conta-1', 'codex-sol', 'high', 'openai'),
];
const profiles: ProfileFact[] = [
  { id: 'claude-code/empresa', kind: 'token_plan', state: 'active' },
  { id: 'codex/conta-1', kind: 'token_plan', state: 'active' },
];
const facts = { discovered, profiles };
const idsOf = (list: { executors: readonly { id: string }[] }): string[] =>
  list.executors.map((item) => item.id);

describe('the default and the layers', () => {
  it('with no configuration expands quality over the accounts that exist', async () => {
    const result = await resolveScenarioRoleExecutors(resolver(), facts);
    expect(result.preset).toBe('quality');
    expect(idsOf(result.roles.author)).toEqual([
      'claude-opus-high@claude-code/empresa',
      'codex-sol-high@codex/conta-1',
    ]);
  });

  it('a scenario replaces the global list only for the role it cites', async () => {
    const config = `
roles:
  author: { executors: [claude-opus-high@claude-code/empresa] }
  reviewer: { executors: [codex-sol-high@codex/conta-1] }
`;
    const records = [
      scenario('s1', {
        configOverride: { roles: { author: { executors: ['codex-sol-high@codex/conta-1'] } } },
      }),
    ];
    const result = await resolveScenarioRoleExecutors(resolver(config, records), facts, 's1');
    expect(idsOf(result.roles.author)).toEqual(['codex-sol-high@codex/conta-1']);
    expect(idsOf(result.roles.reviewer)).toEqual(['codex-sol-high@codex/conta-1']);
    const global = await resolveScenarioRoleExecutors(resolver(config, records), facts);
    expect(idsOf(global.roles.author)).toEqual(['claude-opus-high@claude-code/empresa']);
  });

  it('walks the origin chain, oldest first, and takes dotted keys', async () => {
    const records = [
      scenario('project', { configOverride: { 'roles.preset': 'economical' } }),
      scenario('task', {
        kind: 'task',
        originScenarioId: 'project',
        configOverride: { 'roles.actor.executors': ['codex-sol-high@codex/conta-1'] },
      }),
    ];
    const result = await resolveScenarioRoleExecutors(resolver('', records), facts, 'task');
    expect(result.preset).toBe('economical');
    expect(idsOf(result.roles.actor)).toEqual(['codex-sol-high@codex/conta-1']);
    expect(result.roles.author.executors[0]?.id).toBe('claude-sonnet-medium@claude-code/empresa');
  });

  it('a scheduled-task override comes last', async () => {
    const records = [
      scenario('s1', { configOverride: { roles: { allowed_profiles: ['codex/conta-1'] } } }),
    ];
    const result = await resolveScenarioRoleExecutors(resolver('', records), facts, 's1', {
      roles: { allowed_profiles: ['claude-code/empresa'] },
    });
    expect(idsOf(result.roles.author)).toEqual(['claude-opus-high@claude-code/empresa']);
  });

  it('refuses a malformed override naming the scenario and the key', async () => {
    const records = [
      scenario('s1', { configOverride: { roles: { author: { executors: ['opus'] } } } }),
    ];
    await expect(resolveScenarioRoleExecutors(resolver('', records), facts, 's1')).rejects.toThrow(
      /scenario "s1" configOverride: roles: author\.executors\.0: "opus"/u,
    );
    await expect(
      resolveScenarioRoleExecutors(resolver(), facts, undefined, { roles: { preset: 'premium' } }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('capability_check: block refuses a list somebody wrote below the minimum; warn marks it', async () => {
    const config =
      'roles:\n  capability_check: block\n  director: { executors: [claude-opus-high@claude-code/empresa] }\n';
    const capabilities = new Map([
      ['claude-opus-high@claude-code/empresa', { contextWindow: 8_000 }],
    ]);
    await expect(
      resolveScenarioRoleExecutors(resolver(config), { ...facts, capabilities }),
    ).rejects.toBeInstanceOf(InvalidInput);
    const warn = await resolveScenarioRoleExecutors(resolver(config.replace('block', 'warn')), {
      ...facts,
      capabilities,
    });
    expect(warn.roles.director.executors[0]?.shortfalls).toHaveLength(1);
  });
});

describe('the executors block joins the discovered ones', () => {
  it('the configuration wins on an id', () => {
    const config = parseConfig(`
executors:
  codex-sol-high@codex/conta-1:
    client: codex
    profile: conta-1
    model: codex-sol
    effort: high
`);
    const catalog = executorCatalogOf(config, discovered);
    expect(catalog).toHaveLength(3);
    expect(catalog[0]?.id).toBe('codex-sol-high@codex/conta-1');
  });
});

describe('the old format', () => {
  const yaml = `
orchestration:
  executor: { client: claude-code, profile: empresa, model: claude-sonnet, effort: medium }
  roles:
    author: { client: codex, profile: conta-1, model: codex-sol, effort: high }
`;

  it('is a list of one item per role, orchestration.roles over orchestration.executor', async () => {
    const legacy = legacyExecutorsOf(parseConfig(yaml).orchestration);
    expect(legacy.author?.client).toBe('codex');
    expect(legacy.actor?.client).toBe('claude-code');
    const result = await resolveScenarioRoleExecutors(resolver(yaml), facts);
    expect(idsOf(result.roles.author)).toEqual(['codex-sol-high@codex/conta-1']);
    expect(result.roles.author.source).toBe('legacy');
    expect(idsOf(result.roles.actor)).toEqual(['claude-sonnet-medium@claude-code/empresa']);
  });

  it('warns once per old key in use, and not at all without them', () => {
    const warnings = deprecationWarnings(parseConfig(yaml).orchestration);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/orchestration\.executor is deprecated/u);
    expect(warnings[1]).toMatch(
      /orchestration\.roles\.author is deprecated.*roles\.author\.executors/u,
    );
    expect(deprecationWarnings(parseConfig('').orchestration)).toEqual([]);
  });
});
