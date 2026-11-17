// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  OFFICIAL_TOOLS,
  ROLE_IDS,
  type JsonObject,
  type RolePolicy,
  type ScenarioRecord,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import {
  defaultPolicySettings,
  frameworkToolsOf,
  resolveRolePolicy,
  rolesOverrideOf,
} from './role-policy.js';

const tools = () => OFFICIAL_TOOLS;

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
    tools,
  };
}

const toolsOf = (policy: RolePolicy): readonly string[] => {
  const set = policy.mcpTools.otheater;
  if (set === undefined || set === 'all') throw new Error('expected a list of tools');
  return set;
};

describe('the default policy of each role', () => {
  it('is the policy of before the configuration: read and search, the Actor also writes, no shell, no network', async () => {
    for (const role of ROLE_IDS) {
      const policy = await resolveRolePolicy(resolver(), role);
      expect(policy.nativeTools).toEqual(
        role === 'actor' ? ['read', 'search', 'edit', 'write'] : ['read', 'search'],
      );
      expect(policy).toMatchObject({
        nativeShell: 'none',
        mcpServers: ['otheater'],
        onAsk: 'reject',
        bypass: 'forbidden',
        writeScope: 'worktree',
        network: { allow: [] },
      });
    }
    expect((await resolveRolePolicy(resolver(), 'director')).nativeTools).toEqual([
      'read',
      'search',
    ]);
  });

  it('lists the tools the registry gives the role, with no shell and no network tool', async () => {
    const actor = toolsOf(await resolveRolePolicy(resolver(), 'actor'));
    expect(actor).toEqual(expect.arrayContaining(['read_blackboard', 'submit']));
    for (const shell of ['run_tests', 'install_deps', 'git_commit', 'restricted_shell']) {
      expect(actor).not.toContain(shell);
    }
    expect(actor).not.toContain('http_get');
    expect(toolsOf(await resolveRolePolicy(resolver(), 'director'))).toContain('next_action');
    expect(toolsOf(await resolveRolePolicy(resolver(), 'author'))).toEqual(
      expect.arrayContaining(['submit_plan', 'submit_script_review']),
    );
    expect(toolsOf(await resolveRolePolicy(resolver(), 'reviewer'))).toContain(
      'submit_plan_review',
    );
    expect(toolsOf(await resolveRolePolicy(resolver(), 'scriptwriter'))).toContain('submit_script');
    expect(toolsOf(await resolveRolePolicy(resolver(), 'critic'))).toContain('submit_critique');
  });

  it('gives a role only the tools of its own role', async () => {
    const reviewer = toolsOf(await resolveRolePolicy(resolver(), 'reviewer'));
    expect(reviewer).not.toContain('submit_plan');
    expect(reviewer).not.toContain('next_action');
  });

  it('has the defaults of defaultPolicySettings', () => {
    expect(defaultPolicySettings('actor').nativeTools).toContain('edit');
    expect(defaultPolicySettings('critic').nativeTools).toEqual(['read', 'search']);
  });
});

describe('roles.<role>.policy in the configuration', () => {
  it('the shells key opens the daemon shells for that role only', async () => {
    const yaml = 'roles:\n  actor:\n    policy:\n      native_shell: shells\n';
    const actor = await resolveRolePolicy(resolver(yaml), 'actor');
    expect(actor.nativeShell).toBe('shells');
    expect(toolsOf(actor)).toEqual(
      expect.arrayContaining(['run_tests', 'install_deps', 'git_commit', 'restricted_shell']),
    );
    const critic = await resolveRolePolicy(resolver(yaml), 'critic');
    expect(critic.nativeShell).toBe('none');
    expect(toolsOf(critic)).not.toContain('run_tests');
    // `run_tests` belongs to the Critic too, once the Critic gets the shells; `git_commit` does not.
    const both = 'roles:\n  critic:\n    policy:\n      native_shell: shells\n';
    const shelled = toolsOf(await resolveRolePolicy(resolver(both), 'critic'));
    expect(shelled).toContain('run_tests');
    expect(shelled).not.toContain('git_commit');
  });

  it('the network key lists domains and brings in the tool that reaches out', async () => {
    const yaml =
      'roles:\n  consultant:\n    policy:\n      network:\n        allow: [Docs.Example.com, "*.example.org"]\n';
    const policy = await resolveRolePolicy(resolver(yaml), 'consultant');
    expect(policy.network.allow).toEqual(['docs.example.com', '*.example.org']);
    expect(toolsOf(policy)).toContain('http_get');
    expect(toolsOf(await resolveRolePolicy(resolver(), 'consultant'))).not.toContain('http_get');
  });

  it('the native tools key gives a role the write tools, or takes them away', async () => {
    const yaml =
      'roles:\n  critic:\n    policy:\n      native_tools: [read, search, edit, write]\n';
    expect((await resolveRolePolicy(resolver(yaml), 'critic')).nativeTools).toEqual([
      'read',
      'search',
      'edit',
      'write',
    ]);
    const narrow = 'roles:\n  actor:\n    policy:\n      native_tools: [read]\n';
    expect((await resolveRolePolicy(resolver(narrow), 'actor')).nativeTools).toEqual(['read']);
  });

  it('a key the file leaves out keeps the default', async () => {
    const yaml = 'roles:\n  actor:\n    policy:\n      native_shell: shells\n';
    const policy = await resolveRolePolicy(resolver(yaml), 'actor');
    expect(policy.nativeTools).toEqual(['read', 'search', 'edit', 'write']);
    expect(policy.network.allow).toEqual([]);
    expect(policy.onAsk).toBe('reject');
  });

  it('takes the literals that are the only values (bypass, write_scope, on_ask: reject)', () => {
    const config = parseConfig(
      'roles:\n  actor:\n    policy:\n      bypass: forbidden\n      write_scope: worktree\n      on_ask: reject\n',
    );
    expect(config.roles.actor?.policy).toMatchObject({ bypass: 'forbidden', on_ask: 'reject' });
  });

  it('is empty by default', () => {
    expect(parseConfig('').roles).toEqual({});
  });
});

interface Refusal {
  readonly key: string;
  readonly yaml: string;
  readonly json: unknown;
  readonly message: RegExp;
}

const REFUSALS: readonly Refusal[] = [
  {
    key: 'bypass',
    yaml: 'allowed',
    json: 'allowed',
    message: /bypass: "allowed" is refused.*N99/u,
  },
  {
    key: 'bypass',
    yaml: 'bypassPermissions',
    json: 'bypassPermissions',
    message: /bypass: "bypassPermissions" is refused/u,
  },
  {
    key: 'write_scope',
    yaml: 'repo',
    json: 'repo',
    message: /write_scope: "repo" is refused.*N99/u,
  },
  {
    key: 'write_scope',
    yaml: 'anywhere',
    json: 'anywhere',
    message: /write_scope: "anywhere" is refused/u,
  },
  {
    key: 'native_shell',
    yaml: 'client',
    json: 'client',
    message: /native_shell: "client" is refused.*always forbidden/u,
  },
  { key: 'native_shell', yaml: 'bash', json: 'bash', message: /native_shell: "bash" is refused/u },
  { key: 'native_shell', yaml: 'all', json: 'all', message: /native_shell: "all" is refused/u },
  {
    key: 'on_ask',
    yaml: 'rules',
    json: 'rules',
    message: /on_ask: "rules" needs the release rules.*P2/u,
  },
  { key: 'on_ask', yaml: 'allow', json: 'allow', message: /actor\.policy\.on_ask/u },
  {
    key: 'network',
    yaml: '{ allow: ["*"] }',
    json: { allow: ['*'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'network',
    yaml: '{ allow: ["*.com"] }',
    json: { allow: ['*.com'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'network',
    yaml: '{ allow: ["https://example.com"] }',
    json: { allow: ['https://example.com'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'network',
    yaml: '{ allow: ["example.com:8080"] }',
    json: { allow: ['example.com:8080'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'network',
    yaml: '{ allow: ["example.com/path"] }',
    json: { allow: ['example.com/path'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'network',
    yaml: '{ allow: ["intranet"] }',
    json: { allow: ['intranet'] },
    message: /network\.allow takes host names/u,
  },
  {
    key: 'native_tools',
    yaml: '[bash]',
    json: ['bash'],
    message: /actor\.policy\.native_tools/u,
  },
  { key: 'sandbox', yaml: 'off', json: 'off', message: /actor\.policy/u },
];

describe('what N99 forbids is refused, at the configuration and at the override', () => {
  it.each(REFUSALS)('the daemon refuses $key: $yaml in the configuration', (refusal) => {
    const yaml = `roles:\n  actor:\n    policy:\n      ${refusal.key}: ${refusal.yaml}\n`;
    expect(() => parseConfig(yaml)).toThrow(InvalidInput);
    expect(() => parseConfig(yaml)).toThrow(refusal.message);
  });

  it.each(REFUSALS)('the override of a scenario refuses $key: $yaml', async (refusal) => {
    const record = scenario('s1', {
      configOverride: { [`roles.actor.policy.${refusal.key}`]: refusal.json } as JsonObject,
    });
    await expect(resolveRolePolicy(resolver('', [record]), 'actor', 's1')).rejects.toThrow(
      InvalidInput,
    );
    await expect(resolveRolePolicy(resolver('', [record]), 'actor', 's1')).rejects.toThrow(
      refusal.message,
    );
  });

  it('refuses a role that does not exist (a typo does not pass in silence)', () => {
    expect(() => parseConfig('roles:\n  actors:\n    policy: {}\n')).toThrow(InvalidInput);
  });

  it('the refusal of an override names the scenario, whatever role is asked for', async () => {
    const record = scenario('s9', {
      configOverride: { roles: { actor: { policy: { bypass: 'x' } } } },
    });
    await expect(resolveRolePolicy(resolver('', [record]), 'critic', 's9')).rejects.toThrow(
      /scenario "s9" configOverride/u,
    );
  });
});

describe('the override in a scenario', () => {
  it('a scenario enables the shells of a role with a dotted key', async () => {
    const record = scenario('s1', {
      configOverride: { 'roles.actor.policy.native_shell': 'shells' },
    });
    const policy = await resolveRolePolicy(resolver('', [record]), 'actor', 's1');
    expect(policy.nativeShell).toBe('shells');
    expect(toolsOf(policy)).toContain('git_commit');
  });

  it('accepts the nested form and a dotted path to the whole policy', async () => {
    const nested = scenario('n', {
      configOverride: { roles: { actor: { policy: { network: { allow: ['example.com'] } } } } },
    });
    expect((await resolveRolePolicy(resolver('', [nested]), 'actor', 'n')).network.allow).toEqual([
      'example.com',
    ]);
    const dotted = scenario('d', {
      configOverride: { 'roles.actor.policy': { native_shell: 'shells' } },
    });
    expect((await resolveRolePolicy(resolver('', [dotted]), 'actor', 'd')).nativeShell).toBe(
      'shells',
    );
  });

  it('the override of the scenario wins over the file, and the file wins over the default', async () => {
    const yaml =
      'roles:\n  actor:\n    policy:\n      native_shell: shells\n      native_tools: [read]\n';
    const record = scenario('s1', {
      configOverride: { 'roles.actor.policy.native_shell': 'none' },
    });
    const policy = await resolveRolePolicy(resolver(yaml, [record]), 'actor', 's1');
    expect(policy.nativeShell).toBe('none');
    expect(policy.nativeTools).toEqual(['read']);
    expect((await resolveRolePolicy(resolver(yaml, [record]), 'actor')).nativeShell).toBe('shells');
  });

  it('the scenario it came from comes first, its own override last', async () => {
    const project = scenario('p', {
      configOverride: { 'roles.actor.policy.network': { allow: ['a.example.com'] } },
    });
    const task = scenario('t', {
      kind: 'task',
      originScenarioId: 'p',
      configOverride: { 'roles.actor.policy.native_shell': 'shells' },
    });
    const policy = await resolveRolePolicy(resolver('', [project, task]), 'actor', 't');
    expect(policy.network.allow).toEqual(['a.example.com']);
    expect(policy.nativeShell).toBe('shells');
    const own = scenario('t2', {
      originScenarioId: 'p',
      configOverride: { 'roles.actor.policy.network': { allow: ['b.example.com'] } },
    });
    const wins = await resolveRolePolicy(resolver('', [project, own]), 'actor', 't2');
    expect(wins.network.allow).toEqual(['b.example.com']);
  });

  it('survives a loop in originScenarioId and an unknown scenario', async () => {
    const a = scenario('a', { originScenarioId: 'b' });
    const b = scenario('b', { originScenarioId: 'a' });
    expect((await resolveRolePolicy(resolver('', [a, b]), 'actor', 'a')).nativeShell).toBe('none');
    expect((await resolveRolePolicy(resolver(), 'actor', 'missing')).nativeShell).toBe('none');
  });

  it('leaves the keys that are not roles to their own readers', () => {
    expect(rolesOverrideOf({ 'limits.max_attempts': 3, other: { a: 1 } }, 'x')).toEqual({});
  });
});

describe('frameworkToolsOf', () => {
  it('lists nothing for a role the registry does not know', () => {
    const settings = defaultPolicySettings('actor');
    expect(frameworkToolsOf('actor', settings, OFFICIAL_TOOLS)).not.toContain('next_action');
    expect(frameworkToolsOf('nobody', settings, OFFICIAL_TOOLS)).toEqual([]);
  });
});
