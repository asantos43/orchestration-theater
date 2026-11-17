// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  OFFICIAL_TOOLS,
  type JsonObject,
  type PermissionRule,
  type ScenarioRecord,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { POLICY_ON_ASK_AVAILABLE, POLICY_RULES_MAX } from '../role-policy-config.js';
import { resolveRolePolicy } from './role-policy.js';

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
    tools: () => OFFICIAL_TOOLS,
  };
}

const ACTOR = (policy: string): string => `roles:\n  actor:\n    policy:\n${policy}`;

describe('on_ask: rules', () => {
  it('is an accepted mode now, next to reject', () => {
    expect(POLICY_ON_ASK_AVAILABLE).toEqual(['reject', 'rules']);
    expect(() => parseConfig(ACTOR('      on_ask: rules\n'))).not.toThrow();
  });

  it('stays reject by default, with no rules in the policy', async () => {
    const policy = await resolveRolePolicy(resolver(), 'actor');
    expect(policy.onAsk).toBe('reject');
    expect(policy.rules).toBeUndefined();
  });

  it('keeps the rules out of the policy while on_ask is reject (they are written but not used)', async () => {
    const yaml = ACTOR('      rules:\n        - { action: allow, kind: read }\n');
    const policy = await resolveRolePolicy(resolver(yaml), 'actor');
    expect(policy.onAsk).toBe('reject');
    expect(policy.rules).toBeUndefined();
  });

  it('hands the rules to the policy, with an id for every one (its place when it names none)', async () => {
    const yaml = ACTOR(
      [
        '      on_ask: rules',
        '      rules:',
        '        - { id: docs, action: allow, kind: edit, path: "docs/**" }',
        '        - { action: allow, kind: read }',
        '        - { action: reject, tool: "mcp__*" }',
        '',
      ].join('\n'),
    );
    const policy = await resolveRolePolicy(resolver(yaml), 'actor');
    expect(policy.onAsk).toBe('rules');
    const expected: PermissionRule[] = [
      { id: 'docs', action: 'allow', kind: 'edit', path: 'docs/**' },
      { id: 'rules[1]', action: 'allow', kind: 'read' },
      { id: 'rules[2]', action: 'reject', tool: 'mcp__*' },
    ];
    expect(policy.rules).toEqual(expected);
  });
});

describe('the format of a rule', () => {
  const REFUSED: readonly { name: string; rule: unknown; message: RegExp }[] = [
    {
      name: 'an unknown key',
      rule: { action: 'allow', kind: 'read', glob: 'x' },
      message: /glob/u,
    },
    { name: 'a rule with no criterion', rule: { action: 'allow' }, message: /at least one of/u },
    { name: 'no action', rule: { kind: 'read' }, message: /action/u },
    {
      name: 'an unknown action',
      rule: { action: 'ask', kind: 'read' },
      message: /"ask" is not accepted/u,
    },
    {
      name: 'the reserved id',
      rule: { id: 'none', action: 'allow', kind: 'read' },
      message: /reserved/u,
    },
    {
      name: 'an id with a space',
      rule: { id: 'a b', action: 'allow', kind: 'read' },
      message: /rules\[\]\.id/u,
    },
    { name: 'an empty path', rule: { action: 'allow', path: '' }, message: /path/u },
    {
      name: 'a kind with a symbol',
      rule: { action: 'allow', kind: 'ed it' },
      message: /rules\[\]\.kind/u,
    },
  ];

  it.each(REFUSED)('refuses $name', ({ rule, message }) => {
    const text = ACTOR(`      on_ask: rules\n      rules:\n        - ${JSON.stringify(rule)}\n`);
    expect(() => parseConfig(text)).toThrow(InvalidInput);
    expect(() => parseConfig(text)).toThrow(message);
  });

  it('refuses an explicit id that appears twice', () => {
    const text = ACTOR(
      '      rules:\n        - { id: a, action: allow, kind: read }\n        - { id: a, action: reject, kind: edit }\n',
    );
    expect(() => parseConfig(text)).toThrow(/"a" appears twice/u);
  });

  it('refuses a list longer than the limit', () => {
    const rules = Array.from({ length: POLICY_RULES_MAX + 1 }, () => ({
      action: 'allow',
      kind: 'read',
    }));
    const text = ACTOR(`      rules: ${JSON.stringify(rules)}\n`);
    expect(() => parseConfig(text)).toThrow(/at most 100 rules/u);
  });

  it('refuses a rules key that is not a list', () => {
    expect(() => parseConfig(ACTOR('      rules: all\n'))).toThrow(InvalidInput);
  });
});

/** The rules N99 forbids to release (the configuration refuses them). */
const N99_REFUSALS: readonly { name: string; rule: JsonObject; message: RegExp }[] = [
  {
    name: "the client's shell by kind",
    rule: { action: 'allow', kind: 'execute' },
    message: /kind: "execute" cannot be allowed.*shell.*N99/u,
  },
  {
    name: "the client's shell by kind, in capitals",
    rule: { action: 'allow', kind: 'EXECUTE' },
    message: /cannot be allowed/u,
  },
  {
    name: "the client's shell by tool name (Bash)",
    rule: { action: 'allow', tool: 'Bash' },
    message: /tool: "Bash" is the client's own shell.*N99/u,
  },
  {
    name: "the client's shell by tool name (shell)",
    rule: { action: 'allow', tool: 'shell', kind: 'other' },
    message: /own shell/u,
  },
  {
    name: 'a change of mode (the way into a bypass)',
    rule: { action: 'allow', kind: 'switch_mode' },
    message: /switch_mode.*bypass.*N99/u,
  },
  {
    name: 'a write to an absolute path',
    rule: { action: 'allow', kind: 'edit', path: '/etc/**' },
    message: /leaves the worktree.*N99/u,
  },
  {
    name: 'a write to a Windows path',
    rule: { action: 'allow', kind: 'edit', path: 'C:\\Users\\**' },
    message: /leaves the worktree/u,
  },
  {
    name: 'a write to the home folder',
    rule: { action: 'allow', kind: 'edit', path: '~/.ssh/*' },
    message: /leaves the worktree/u,
  },
  {
    name: 'a write above the worktree',
    rule: { action: 'allow', kind: 'edit', path: '../outside/**' },
    message: /leaves the worktree/u,
  },
  {
    name: 'a write above the worktree, in the middle of the path',
    rule: { action: 'allow', path: 'src/../../x' },
    message: /leaves the worktree/u,
  },
];

describe('what N99 forbids a rule to release', () => {
  it.each(N99_REFUSALS)('the daemon refuses $name in the configuration', ({ rule, message }) => {
    const text = ACTOR(`      on_ask: rules\n      rules:\n        - ${JSON.stringify(rule)}\n`);
    expect(() => parseConfig(text)).toThrow(InvalidInput);
    expect(() => parseConfig(text)).toThrow(message);
  });

  it.each(N99_REFUSALS)('the override of a scenario refuses $name', async ({ rule, message }) => {
    const record = scenario('s1', {
      configOverride: { 'roles.actor.policy.rules': [rule] } as JsonObject,
    });
    await expect(resolveRolePolicy(resolver('', [record]), 'actor', 's1')).rejects.toThrow(
      InvalidInput,
    );
    await expect(resolveRolePolicy(resolver('', [record]), 'actor', 's1')).rejects.toThrow(message);
  });

  it('refuses a release of the network while network.allow is empty, in whatever layer the list comes from', async () => {
    const yaml = ACTOR(
      '      on_ask: rules\n      rules:\n        - { action: allow, kind: fetch }\n',
    );
    await expect(resolveRolePolicy(resolver(yaml), 'actor')).rejects.toThrow(
      /kind "fetch" needs domains in network\.allow.*N99/u,
    );
    const record = scenario('s1', {
      configOverride: { 'roles.actor.policy.rules': [{ action: 'allow', kind: 'fetch' }] },
    });
    const withOn = ACTOR('      on_ask: rules\n');
    await expect(resolveRolePolicy(resolver(withOn, [record]), 'actor', 's1')).rejects.toThrow(
      /needs domains in network\.allow/u,
    );
  });

  it('accepts the release of a fetch once network.allow has a domain (the run time still checks the host)', async () => {
    const yaml = ACTOR(
      '      on_ask: rules\n      network: { allow: ["example.com"] }\n      rules:\n        - { action: allow, kind: fetch }\n',
    );
    const policy = await resolveRolePolicy(resolver(yaml), 'actor');
    expect(policy.rules).toEqual([{ id: 'rules[0]', action: 'allow', kind: 'fetch' }]);
  });

  it('accepts a rule that REJECTS those things, and a path inside the worktree', () => {
    const text = ACTOR(
      [
        '      on_ask: rules',
        '      rules:',
        '        - { action: reject, kind: execute }',
        '        - { action: reject, tool: Bash }',
        '        - { action: reject, path: "/etc/**" }',
        '        - { action: allow, kind: edit, path: "src/**/*.ts" }',
        '',
      ].join('\n'),
    );
    expect(() => parseConfig(text)).not.toThrow();
  });
});

describe('the layers of the rules', () => {
  const rule = (id: string, kind: string, action: 'allow' | 'reject' = 'allow') => ({
    id,
    action,
    kind,
  });
  const ON = 'roles.actor.policy.on_ask';
  const RULES = 'roles.actor.policy.rules';
  const FILE = ACTOR(
    '      on_ask: rules\n      rules:\n        - { id: file, action: allow, kind: read }\n',
  );

  it('the default has no rules and the file replaces it', async () => {
    expect((await resolveRolePolicy(resolver(), 'actor')).rules).toBeUndefined();
    expect((await resolveRolePolicy(resolver(FILE), 'actor')).rules).toEqual([
      rule('file', 'read'),
    ]);
  });

  it('the override of a scenario replaces the list of the file (a list replaces the list)', async () => {
    const record = scenario('s1', { configOverride: { [RULES]: [rule('own', 'search')] } });
    const policy = await resolveRolePolicy(resolver(FILE, [record]), 'actor', 's1');
    expect(policy.rules).toEqual([rule('own', 'search')]);
    expect((await resolveRolePolicy(resolver(FILE, [record]), 'actor')).rules).toEqual([
      rule('file', 'read'),
    ]);
  });

  it('the scenario it came from comes first and its own override last', async () => {
    const project = scenario('p', {
      configOverride: { [ON]: 'rules', [RULES]: [rule('from-project', 'read')] },
    });
    const inherits = scenario('t1', { kind: 'task', originScenarioId: 'p' });
    const replaces = scenario('t2', {
      kind: 'task',
      originScenarioId: 'p',
      configOverride: { [RULES]: [rule('from-task', 'edit')] },
    });
    const records = [project, inherits, replaces];
    expect((await resolveRolePolicy(resolver('', records), 'actor', 't1')).rules).toEqual([
      rule('from-project', 'read'),
    ]);
    expect((await resolveRolePolicy(resolver('', records), 'actor', 't2')).rules).toEqual([
      rule('from-task', 'edit'),
    ]);
  });

  it('a scenario can turn the rules off with on_ask: reject, and an empty list clears them', async () => {
    const off = scenario('off', { configOverride: { [ON]: 'reject' } });
    expect((await resolveRolePolicy(resolver(FILE, [off]), 'actor', 'off')).rules).toBeUndefined();
    const cleared = scenario('cleared', { configOverride: { [RULES]: [] } });
    const policy = await resolveRolePolicy(resolver(FILE, [cleared]), 'actor', 'cleared');
    expect(policy.onAsk).toBe('rules');
    expect(policy.rules).toEqual([]);
  });

  it('a scenario turns the rules on for a role that the file left on reject', async () => {
    const record = scenario('s1', {
      configOverride: { [ON]: 'rules', [RULES]: [rule('r', 'read')] },
    });
    const policy = await resolveRolePolicy(resolver('', [record]), 'actor', 's1');
    expect(policy.onAsk).toBe('rules');
    expect(policy.rules).toEqual([rule('r', 'read')]);
  });

  it('the rules of one role do not reach another', async () => {
    expect((await resolveRolePolicy(resolver(FILE), 'critic')).rules).toBeUndefined();
  });
});
