// SPDX-License-Identifier: MPL-2.0
import type { RolePolicy } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERNAL_TOOLS,
  DEFAULT_SHELL_KEYS,
  DENY_ALL_POLICY,
  mcpToolPrefix,
  opencodePermission,
  serializePermission,
} from './permission.js';

const policy = (patch: Partial<RolePolicy> = {}): RolePolicy => ({
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
  ...patch,
});

describe('opencodePermission', () => {
  it('starts from "*": ask, so the first key of the object is the catch-all', () => {
    expect(Object.keys(opencodePermission(policy()))[0]).toBe('*');
    expect(opencodePermission(policy())['*']).toBe('ask');
  });

  it('allows the tools the role has and denies (removes) the others', () => {
    const reader = opencodePermission(policy({ nativeTools: ['read', 'search'] }));
    expect(reader).toMatchObject({
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'deny',
    });
    const writer = opencodePermission(
      policy({ nativeTools: ['read', 'edit'], editInWorktree: 'allow' }),
    );
    expect(writer).toMatchObject({ read: 'allow', glob: 'deny', grep: 'deny', edit: 'allow' });
    expect(
      opencodePermission(policy({ nativeTools: ['write'], editInWorktree: 'allow' })).edit,
    ).toBe('allow');
  });

  it('edit follows edit_in_worktree (N182): allow spares the request, ask (or absent) sends it to layer 2', () => {
    const writes = ['read', 'search', 'edit', 'write'] as const;
    expect(opencodePermission(policy({ nativeTools: writes, editInWorktree: 'allow' })).edit).toBe(
      'allow',
    );
    expect(opencodePermission(policy({ nativeTools: writes, editInWorktree: 'ask' })).edit).toBe(
      'ask',
    );
    expect(opencodePermission(policy({ nativeTools: writes })).edit).toBe('ask');
    expect(opencodePermission(policy({ nativeTools: ['write'], editInWorktree: 'ask' })).edit).toBe(
      'ask',
    );
  });

  it('edit_in_worktree: allow does not give edit to a role with no edit or write tool (N182)', () => {
    const rules = opencodePermission(
      policy({ nativeTools: ['read', 'search'], editInWorktree: 'allow' }),
    );
    expect(rules.edit).toBe('deny');
  });

  it('always denies the shell, the tools outside the four native ones and external directories', () => {
    for (const nativeTools of [[], ['read', 'search', 'edit', 'write']] as const) {
      const rules = opencodePermission(policy({ nativeTools }));
      expect(rules).toMatchObject({
        bash: 'deny',
        external_directory: 'deny',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        skill: 'deny',
      });
    }
  });

  it('shell keys are a setting: a client that calls the shell "shell" is covered too', () => {
    expect(DEFAULT_SHELL_KEYS).toEqual(['bash']);
    const rules = opencodePermission(policy(), { shellKeys: ['bash', 'shell'] });
    expect(rules).toMatchObject({ bash: 'deny', shell: 'deny' });
    expect(opencodePermission(policy())).not.toHaveProperty('shell');
  });

  it('allows only the MCP tools the role lists, by server and tool name', () => {
    const rules = opencodePermission(
      policy({
        mcpServers: ['otheater-shells', 'my server'],
        mcpTools: { 'otheater-shells': ['run_tests', 'read_file'], 'my server': 'all' },
      }),
    );
    expect(rules['otheater-shells_run_tests']).toBe('allow');
    expect(rules['otheater-shells_read_file']).toBe('allow');
    expect(rules['my_server_*']).toBe('allow');
    expect(rules).not.toHaveProperty('otheater-shells_*');
    expect(mcpToolPrefix('a.b/c')).toBe('a_b_c');
  });

  it('a server of the role with no tool listed has no tool allowed (fail closed)', () => {
    const rules = opencodePermission(policy({ mcpServers: ['otheater'], mcpTools: {} }));
    expect(Object.keys(rules).filter((key) => key.startsWith('otheater'))).toEqual([]);
  });

  it('a tool of a server the policy does not list is not allowed', () => {
    const rules = opencodePermission(
      policy({ mcpServers: [], mcpTools: { otheater: ['submit'] } }),
    );
    expect(rules).not.toHaveProperty('otheater_submit');
  });

  it('is pure and does not change the policy', () => {
    const input = policy({ mcpServers: ['x'] });
    const before = JSON.stringify(input);
    expect(opencodePermission(input)).toEqual(opencodePermission(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('serializes to JSON that keeps the order of the keys', () => {
    const text = serializePermission(opencodePermission(policy()));
    expect(text.startsWith('{"*":"ask"')).toBe(true);
    expect(JSON.parse(text)).toEqual(opencodePermission(policy()));
  });

  it('a policy with nothing allows only the session-internal tools: the fail-closed one', () => {
    const rules = opencodePermission(DENY_ALL_POLICY);
    const allowed = Object.entries(rules).filter(([, action]) => action === 'allow');
    expect(allowed.map(([key]) => key)).toEqual([...DEFAULT_INTERNAL_TOOLS]);
    expect(opencodePermission(DENY_ALL_POLICY, { internalTools: [] })).not.toHaveProperty(
      'todowrite',
    );
  });

  it('the internal tools are allowed, after the deny rules, and are a setting', () => {
    const rules = opencodePermission(policy());
    expect(rules.todowrite).toBe('allow');
    expect(rules.todoread).toBe('allow');
    const keys = Object.keys(rules);
    expect(keys.indexOf('todowrite')).toBeGreaterThan(keys.indexOf('external_directory'));
    const custom = opencodePermission(policy(), { internalTools: ['todowrite'] });
    expect(custom).not.toHaveProperty('todoread');
  });

  it('an internal tool never loosens a native tool, the shell or a removed tool', () => {
    const rules = opencodePermission(policy({ nativeTools: [] }), {
      internalTools: ['bash', 'read', 'task'],
    });
    expect(rules.bash).toBe('deny');
    expect(rules.read).toBe('deny');
    expect(rules.task).toBe('deny');
  });
});

describe('the translation for each role (Phase 4, P1)', () => {
  const roles: readonly {
    readonly role: string;
    readonly nativeTools: RolePolicy['nativeTools'];
    readonly tools: readonly string[];
  }[] = [
    { role: 'director', nativeTools: ['read', 'search'], tools: ['next_action', 'ask_producer'] },
    { role: 'author', nativeTools: ['read', 'search'], tools: ['submit_plan'] },
    { role: 'reviewer', nativeTools: ['read', 'search'], tools: ['submit_plan_review'] },
    { role: 'scriptwriter', nativeTools: ['read', 'search'], tools: ['submit_script'] },
    {
      role: 'actor',
      nativeTools: ['read', 'search', 'edit', 'write'],
      tools: ['submit', 'read_blackboard'],
    },
    { role: 'critic', nativeTools: ['read', 'search'], tools: ['submit_critique'] },
    { role: 'consultant', nativeTools: ['read', 'search'], tools: ['read_blackboard'] },
  ];

  for (const row of roles) {
    const mine = policy({
      nativeTools: row.nativeTools,
      editInWorktree: 'allow',
      mcpServers: ['otheater'],
      mcpTools: { otheater: row.tools },
    });

    it(`${row.role}: allows its native tools and its own MCP tools by name, nothing else`, () => {
      const rules = opencodePermission(mine);
      expect(rules.read).toBe('allow');
      expect(rules.edit).toBe(row.nativeTools.includes('edit') ? 'allow' : 'deny');
      expect(rules.bash).toBe('deny');
      expect(rules.external_directory).toBe('deny');
      const allowedMcp = Object.keys(rules).filter(
        (key) => key.startsWith('otheater_') && rules[key] === 'allow',
      );
      expect(allowedMcp).toEqual(row.tools.map((tool) => `otheater_${tool}`));
      expect(rules['otheater_*']).toBeUndefined();
    });

    it(`${row.role}: with the daemon shells the client shell stays denied and the shells come in by name`, () => {
      const rules = opencodePermission({
        ...mine,
        nativeShell: 'shells',
        mcpTools: { otheater: [...row.tools, 'run_tests'] },
      });
      expect(rules.bash).toBe('deny');
      expect(rules.otheater_run_tests).toBe('allow');
      expect(rules['*']).toBe('ask');
    });
  }
});
