// SPDX-License-Identifier: MPL-2.0
import type { RolePolicy } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  acpOptions,
  allowedMcpRules,
  allowedTools,
  deniedTools,
  headlessArgs,
  isManagedToolName,
  permissionSettings,
  SESSION_MODE,
  SETTING_SOURCES,
  SETTING_SOURCES_MODES,
} from './policy.js';

const base: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

describe('allowedTools and deniedTools', () => {
  it('grant only the categories of the policy, in a fixed order', () => {
    expect(allowedTools({ ...base, nativeTools: ['write', 'read'] })).toEqual(['Read', 'Write']);
    expect(allowedTools({ ...base, nativeTools: ['search', 'edit'] })).toEqual([
      'Glob',
      'Grep',
      'Edit',
    ]);
  });

  it('never grant the shell, and deny it first', () => {
    for (const nativeTools of [[], ['read', 'search', 'edit', 'write']] as const) {
      const policy: RolePolicy = { ...base, nativeTools };
      expect(allowedTools(policy)).not.toContain('Bash');
      expect(deniedTools(policy)[0]).toBe('Bash');
    }
  });

  it('split the managed tools between them with no overlap and no gap', () => {
    const policy: RolePolicy = { ...base, nativeTools: ['read', 'edit'] };
    const allowed = allowedTools(policy);
    const denied = deniedTools(policy);
    expect(allowed.filter((name) => denied.includes(name))).toEqual([]);
    expect([...allowed, ...denied].sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'].sort(),
    );
  });

  it('with no tool at all, deny every managed tool', () => {
    expect(allowedTools({ ...base, nativeTools: [] })).toEqual([]);
    expect(deniedTools({ ...base, nativeTools: [] })).toHaveLength(6);
  });
});

describe('isManagedToolName', () => {
  it('knows the names of the policy and nothing else', () => {
    expect(isManagedToolName('Bash')).toBe(true);
    expect(isManagedToolName('Read')).toBe(true);
    expect(isManagedToolName('Bash(touch:*)')).toBe(false);
    expect(isManagedToolName('WebFetch')).toBe(false);
    expect(isManagedToolName(42)).toBe(false);
  });
});

describe('allowedMcpRules', () => {
  it('is empty when the policy has no MCP server', () => {
    expect(allowedMcpRules(base)).toEqual([]);
  });

  it('gives one mcp__<server>__<tool> rule per tool, in order, without repeats', () => {
    expect(
      allowedMcpRules({
        ...base,
        mcpServers: ['otheater', 'docs', 'otheater'],
        mcpTools: { otheater: ['submit', 'read_blackboard', 'submit'], docs: ['search'] },
      }),
    ).toEqual(['mcp__otheater__submit', 'mcp__otheater__read_blackboard', 'mcp__docs__search']);
  });

  it('gives the rule of the whole server only for a server whose tools are all', () => {
    expect(allowedMcpRules({ ...base, mcpServers: ['docs'], mcpTools: { docs: 'all' } })).toEqual([
      'mcp__docs',
    ]);
  });

  it('allows no tool of a server the policy gives no list (fail closed)', () => {
    expect(allowedMcpRules({ ...base, mcpServers: ['otheater'], mcpTools: {} })).toEqual([]);
  });

  it('ignores the tools of a server the policy does not list', () => {
    expect(
      allowedMcpRules({ ...base, mcpServers: [], mcpTools: { otheater: ['submit'] } }),
    ).toEqual([]);
  });

  it('writes the server and tool names the way Claude Code writes them in a tool name', () => {
    expect(
      allowedMcpRules({
        ...base,
        mcpServers: ['my.server', 'a b', 'ok_1-x'],
        mcpTools: { 'my.server': ['do.it'], 'a b': ['x y'], 'ok_1-x': ['t-1'] },
      }),
    ).toEqual(['mcp__my_server__do_it', 'mcp__a_b__x_y', 'mcp__ok_1-x__t-1']);
  });

  it('never allows a native tool or the shell, whatever the policy grants', () => {
    const policy: RolePolicy = {
      ...base,
      nativeTools: ['read', 'search', 'edit', 'write'],
      mcpServers: ['otheater'],
      mcpTools: { otheater: ['submit', 'run_tests'] },
      nativeShell: 'shells',
    };
    for (const rule of allowedMcpRules(policy)) expect(rule).toMatch(/^mcp__/u);
    expect(allowedMcpRules(policy)).not.toContain('Bash');
  });
});

describe('permissionSettings', () => {
  it('disables the bypass mode and denies the tools of the policy', () => {
    expect(permissionSettings(base)).toEqual({
      disableBypassPermissionsMode: 'disable',
      allow: [],
      deny: deniedTools(base),
    });
  });

  it('allows the MCP tools of the policy and nothing else', () => {
    const policy: RolePolicy = {
      ...base,
      mcpServers: ['otheater'],
      mcpTools: { otheater: ['submit'] },
    };
    expect(permissionSettings(policy).allow).toEqual(['mcp__otheater__submit']);
    expect(permissionSettings(policy).deny).toEqual(deniedTools(policy));
  });
});

describe('acpOptions', () => {
  it('carries the tools, the strict MCP flag and the closed bypass', () => {
    const options = acpOptions(base, 'none');
    expect(options.tools).toEqual(['Read']);
    expect(options.disallowedTools).toEqual(deniedTools(base));
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(options.allowedTools).toEqual([]);
    expect(options.settings.permissions.allow).toEqual([]);
  });

  it('lets the tools of the MCP servers of the role run with no permission request', () => {
    const policy: RolePolicy = {
      ...base,
      mcpServers: ['otheater'],
      mcpTools: { otheater: ['submit'] },
    };
    const options = acpOptions(policy, 'none');
    expect(options.allowedTools).toEqual(['mcp__otheater__submit']);
    expect(options.settings.permissions.allow).toEqual(['mcp__otheater__submit']);
    // The shell and the native tools are not in `allowedTools`: the mode and layer 2 decide them.
    expect(options.allowedTools).not.toContain('Bash');
    expect(options.allowedTools).not.toContain('Read');
    expect(options.disallowedTools).toContain('Bash');
  });

  it('maps each setting-sources mode to the SDK list', () => {
    expect(acpOptions(base, 'none').settingSources).toEqual([]);
    expect(acpOptions(base, 'project').settingSources).toEqual(['project']);
    expect(acpOptions(base, 'user').settingSources).toEqual(['user', 'project', 'local']);
    expect(Object.keys(SETTING_SOURCES)).toEqual([...SETTING_SOURCES_MODES]);
  });

  it('starts every session in the default mode', () => {
    expect(SESSION_MODE).toBe('default');
  });
});

describe('headlessArgs', () => {
  it('lists the flags of the emergency exit with the same policy', () => {
    const args = headlessArgs(base, 'none');
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(after('--output-format')).toBe('stream-json');
    expect(after('--tools')).toBe('Read');
    expect(after('--disallowedTools')).toBe(deniedTools(base).join(','));
    expect(after('--permission-mode')).toBe('default');
    expect(after('--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
  });

  it('has no --allowedTools while the policy lists no MCP server', () => {
    expect(headlessArgs(base, 'none')).not.toContain('--allowedTools');
  });

  it('allows the MCP tools of the policy with --allowedTools', () => {
    const args = headlessArgs(
      {
        ...base,
        mcpServers: ['otheater', 'docs'],
        mcpTools: { otheater: ['submit'], docs: 'all' },
      },
      'none',
    );
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__otheater__submit,mcp__docs');
  });

  it('never asks for a mode or a flag that skips permissions', () => {
    const args = headlessArgs(base, 'user');
    expect(args.join(' ')).not.toMatch(/bypass|dangerously|skip-permissions/iu);
  });
});

/** The policy each role gets (shape of the daemon's default; the tool names are literal here). */
const ROLE_TABLE: readonly {
  readonly role: string;
  readonly nativeTools: RolePolicy['nativeTools'];
  readonly tools: readonly string[];
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}[] = [
  {
    role: 'director',
    nativeTools: ['read', 'search'],
    tools: ['next_action', 'ask_producer'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
  {
    role: 'author',
    nativeTools: ['read', 'search'],
    tools: ['submit_plan'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
  {
    role: 'reviewer',
    nativeTools: ['read', 'search'],
    tools: ['submit_plan_review'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
  {
    role: 'scriptwriter',
    nativeTools: ['read', 'search'],
    tools: ['submit_script'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
  {
    role: 'actor',
    nativeTools: ['read', 'search', 'edit', 'write'],
    tools: ['submit', 'read_blackboard'],
    allowed: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    denied: ['Bash'],
  },
  {
    role: 'critic',
    nativeTools: ['read', 'search'],
    tools: ['submit_critique'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
  {
    role: 'consultant',
    nativeTools: ['read', 'search'],
    tools: ['read_blackboard'],
    allowed: ['Read', 'Glob', 'Grep'],
    denied: ['Bash', 'Edit', 'Write'],
  },
];

describe('the translation for each role (Phase 4, P1)', () => {
  for (const row of ROLE_TABLE) {
    const policy: RolePolicy = {
      ...base,
      nativeTools: row.nativeTools,
      mcpServers: ['otheater'],
      mcpTools: { otheater: row.tools },
    };

    it(`${row.role}: native tools, shell removed, one MCP rule per tool`, () => {
      const rules = row.tools.map((tool) => `mcp__otheater__${tool}`);
      const options = acpOptions(policy, 'none');
      expect(options.tools).toEqual(row.allowed);
      expect(options.disallowedTools).toEqual(row.denied);
      expect(options.allowedTools).toEqual(rules);
      expect(options.settings.permissions.allow).toEqual(rules);
      expect(options.allowDangerouslySkipPermissions).toBe(false);
      const args = headlessArgs(policy, 'none');
      expect(args[args.indexOf('--tools') + 1]).toBe(row.allowed.join(','));
      expect(args[args.indexOf('--allowedTools') + 1]).toBe(rules.join(','));
      // Never the whole server, which would let a tool of the server the role lacks run.
      expect(options.allowedTools).not.toContain('mcp__otheater');
    });

    it(`${row.role}: the shells of the daemon change no native key and add no rule beyond mcpTools`, () => {
      const withShells: RolePolicy = {
        ...policy,
        nativeShell: 'shells',
        mcpTools: { otheater: [...row.tools, 'run_tests', 'restricted_shell'] },
      };
      const options = acpOptions(withShells, 'none');
      expect(options.tools).toEqual(row.allowed);
      expect(options.disallowedTools).toEqual(row.denied);
      expect(options.disallowedTools[0]).toBe('Bash');
      expect(options.allowedTools).toEqual([
        ...row.tools.map((tool) => `mcp__otheater__${tool}`),
        'mcp__otheater__run_tests',
        'mcp__otheater__restricted_shell',
      ]);
    });
  }

  it('a server with no entry in mcpTools gets no rule, and "all" gets the server rule', () => {
    const open: RolePolicy = {
      ...base,
      mcpServers: ['otheater', 'docs'],
      mcpTools: { docs: 'all' },
    };
    expect(allowedMcpRules(open)).toEqual(['mcp__docs']);
  });
});
