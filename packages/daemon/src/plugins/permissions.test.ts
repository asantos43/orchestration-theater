// SPDX-License-Identifier: MPL-2.0
import {
  decidePermission,
  parsePluginManifest,
  type PluginManifest,
  type PluginToolManifest,
  type RolePolicy,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  buildRolePolicy,
  defaultPolicySettings,
  type PolicySettings,
} from '../orchestration/role-policy.js';
import { buildDaemonRegistries } from '../registries.js';
import {
  allowedPluginTools,
  approvalOf,
  DEFAULT_PLUGIN_PERMISSIONS,
  judgePluginTool,
  pluginPermissionsFromConfig,
  withPluginTools,
  type PluginPermissionSettings,
} from './permissions.js';

/** A plugin with several roles and the four effects, to read the matrix from. */
function matrixManifest(): PluginManifest {
  const result = parsePluginManifest({
    manifest_version: 1,
    id: 'mx',
    version: '1.0.0',
    server: { type: 'stdio', command: ['node', 'server.js'] },
    tools: [
      { name: 'lookup', roles: ['consultant', 'author', 'reviewer', 'critic'], effects: 'read' },
      {
        name: 'format',
        roles: ['consultant', 'author', 'actor', 'critic'],
        effects: 'local_write',
      },
      { name: 'fetch', roles: ['consultant', 'author', 'actor', 'critic'], effects: 'network' },
      {
        name: 'publish',
        roles: ['consultant', 'author', 'actor', 'critic'],
        effects: 'external_write',
      },
      {
        name: 'announce',
        roles: ['consultant', 'actor', 'critic'],
        effects: 'external_write',
        requires_producer_approval: true,
      },
      { name: 'panel_only', roles: [], effects: 'read' },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.manifest;
}

const MANIFEST = matrixManifest();
const NAMES = new Map(MANIFEST.tools.map((tool) => [`${MANIFEST.id}__${tool.name}`, { tool }]));
const TOOLS = buildDaemonRegistries().tools.list();

function toolOf(name: string): PluginToolManifest {
  const found = MANIFEST.tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no tool ${name} in the manifest`);
  return found;
}

const listOf = (policy: RolePolicy): string[] => {
  const listed = policy.mcpTools.otheater;
  return listed === undefined || listed === 'all' ? [] : [...listed];
};

function policyOf(role: string, settings: Partial<PolicySettings> = {}): RolePolicy {
  return buildRolePolicy(role, { ...defaultPolicySettings(role), ...settings }, TOOLS);
}

function allowed(
  role: string,
  settings: Partial<PolicySettings> = {},
  config: Partial<PluginPermissionSettings> = {},
): string[] {
  return allowedPluginTools(NAMES, role, policyOf(role, settings), {
    ...DEFAULT_PLUGIN_PERMISSIONS,
    ...config,
  }).map((name) => name.slice('mx__'.length));
}

describe('the role x tool matrix of the manifest (N237)', () => {
  it('gives each role the tools it is listed for and whose effect its policy fits', () => {
    // Default policies: the consultant and the actor write; the author, the reviewer and the critic
    // only read. Nobody has a domain in network.allow, so no `network` tool.
    expect(allowed('consultant')).toEqual(['lookup', 'format', 'publish', 'announce']);
    expect(allowed('actor')).toEqual(['format', 'publish', 'announce']);
    expect(allowed('author')).toEqual(['lookup']);
    expect(allowed('reviewer')).toEqual(['lookup']);
    expect(allowed('critic')).toEqual(['lookup']);
    expect(allowed('scriptwriter')).toEqual([]);
  });

  it('a tool with no roles is the panel only: no role gets it', () => {
    for (const role of ['consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic']) {
      expect(allowed(role, { network: { allow: ['example.com'] } })).not.toContain('panel_only');
    }
  });

  it('a domain in network.allow gives the network tools to the roles listed', () => {
    const network = { allow: ['example.com'] };
    expect(allowed('author', { network })).toEqual(['lookup', 'fetch']);
    expect(allowed('critic', { network })).toEqual(['lookup', 'fetch']);
    expect(allowed('reviewer', { network })).toEqual(['lookup']);
  });

  it('the manifest cannot release what the policy of the role denies (the Critic and a write)', () => {
    // The Critic is listed for `format`, `publish` and `announce`, and has no edit or write.
    const critic = allowed('critic', { network: { allow: ['example.com'] } });
    expect(critic).not.toContain('format');
    expect(critic).not.toContain('publish');
    expect(critic).not.toContain('announce');
    const verdict = judgePluginTool(
      toolOf('format'),
      'critic',
      policyOf('critic'),
      DEFAULT_PLUGIN_PERMISSIONS,
    );
    expect(verdict).toEqual({ allowed: false, reason: 'role_cannot_write' });
    // No mode of the configuration opens a write to a role that cannot write by itself, but
    // `shells` is the one that asks for the shells and not for the edit.
    for (const localWrite of ['writes', 'deny'] as const) {
      expect(allowed('critic', {}, { localWrite })).not.toContain('format');
    }
    for (const externalWrite of ['writes', 'deny'] as const) {
      expect(allowed('critic', {}, { externalWrite })).not.toContain('publish');
    }
    expect(allowed('critic', { nativeShell: 'none' }, { localWrite: 'shells' })).not.toContain(
      'format',
    );
  });

  it('a role with an edit still needs the manifest to list it', () => {
    // The author is not listed for `announce`: giving it the edit does not add the tool.
    const author = allowed('author', { nativeTools: ['read', 'search', 'edit', 'write'] });
    expect(author).toContain('format');
    expect(author).toContain('publish');
    expect(author).not.toContain('announce');
  });
});

describe('plugins.permissions modes [proposta]', () => {
  it('local_write: deny gives no write tool; shells follows native_shell', () => {
    expect(allowed('actor', {}, { localWrite: 'deny' })).not.toContain('format');
    expect(allowed('actor', {}, { localWrite: 'shells' })).toContain('format');
    // The author has no shells and no edit: `shells` is not `writes`, and it stays without.
    expect(allowed('author', {}, { localWrite: 'shells' })).not.toContain('format');
    expect(allowed('author', { nativeShell: 'shells' }, { localWrite: 'shells' })).toContain(
      'format',
    );
    // `shells` does not need the edit: the actor without edit and write still gets the tool.
    expect(
      allowed('actor', { nativeTools: ['read', 'search'] }, { localWrite: 'shells' }),
    ).toContain('format');
  });

  it('network: any ignores network.allow; deny closes it even with a domain', () => {
    expect(allowed('author', {}, { network: 'any' })).toContain('fetch');
    expect(
      allowed('author', { network: { allow: ['example.com'] } }, { network: 'deny' }),
    ).not.toContain('fetch');
  });

  it('external_write: deny gives no such tool, even to the roles that write', () => {
    const tools = allowed('actor', {}, { externalWrite: 'deny' });
    expect(tools).not.toContain('publish');
    expect(tools).not.toContain('announce');
    expect(tools).toContain('format');
  });

  it('the reasons of a denial are stable', () => {
    const settings = DEFAULT_PLUGIN_PERMISSIONS;
    const [lookup, format, fetch] = [toolOf('lookup'), toolOf('format'), toolOf('fetch')];
    expect(judgePluginTool(lookup, 'actor', policyOf('actor'), settings)).toEqual({
      allowed: false,
      reason: 'role_not_listed',
    });
    expect(judgePluginTool(fetch, 'actor', policyOf('actor'), settings)).toEqual({
      allowed: false,
      reason: 'no_network',
    });
    expect(
      judgePluginTool(format, 'actor', policyOf('actor'), { ...settings, localWrite: 'deny' }),
    ).toEqual({ allowed: false, reason: 'denied_by_config' });
    expect(
      judgePluginTool(format, 'critic', policyOf('critic'), { ...settings, localWrite: 'shells' }),
    ).toEqual({ allowed: false, reason: 'no_shell' });
  });

  it('reads the values of a parsed config section', () => {
    expect(
      pluginPermissionsFromConfig({
        local_write: 'shells',
        network: 'any',
        external_write: 'deny',
        external_write_approval: 'manifest',
        approval_detail: 'values',
      }),
    ).toEqual({
      localWrite: 'shells',
      network: 'any',
      externalWrite: 'deny',
      externalWriteApproval: 'manifest',
      approvalDetail: 'values',
    });
  });
});

describe('approval', () => {
  const [lookup, publish, announce] = [toolOf('lookup'), toolOf('publish'), toolOf('announce')];

  it('asks for what the manifest asks, and for external_write unless the config leaves it to the manifest', () => {
    expect(approvalOf(lookup, DEFAULT_PLUGIN_PERMISSIONS)).toBe('none');
    expect(approvalOf(announce, DEFAULT_PLUGIN_PERMISSIONS)).toBe('manifest');
    expect(approvalOf(publish, DEFAULT_PLUGIN_PERMISSIONS)).toBe('policy');
    const manifestOnly = { ...DEFAULT_PLUGIN_PERMISSIONS, externalWriteApproval: 'manifest' };
    expect(approvalOf(publish, manifestOnly as PluginPermissionSettings)).toBe('none');
    // The manifest asking is never lowered by the config.
    expect(approvalOf(announce, manifestOnly as PluginPermissionSettings)).toBe('manifest');
  });

  it('the verdict of an allowed tool carries the approval it needs', () => {
    expect(
      judgePluginTool(announce, 'actor', policyOf('actor'), DEFAULT_PLUGIN_PERMISSIONS),
    ).toEqual({ allowed: true, approval: 'manifest' });
  });
});

describe('withPluginTools', () => {
  const names = ['mx__lookup', 'mx__format'];

  it('adds the names to the framework server list of the policy', () => {
    const base = policyOf('actor');
    const policy = withPluginTools(base, 'otheater', names);
    // The framework tools stay, the plugin ones follow, and nothing else of the policy changes.
    expect(listOf(policy)).toEqual([...listOf(base), ...names]);
    expect({ ...policy, mcpTools: base.mcpTools }).toEqual(base);
  });

  it('leaves the policy alone with no tool, with `all`, or with no framework server', () => {
    const base = policyOf('actor');
    expect(withPluginTools(base, 'otheater', [])).toBe(base);
    const all = { ...base, mcpTools: { otheater: 'all' as const } };
    expect(withPluginTools(all, 'otheater', names)).toBe(all);
    const none = { ...base, mcpServers: [] };
    expect(withPluginTools(none, 'otheater', names)).toBe(none);
  });
});

describe('the list the three adapters read (layers 1 and 2)', () => {
  const settings = DEFAULT_PLUGIN_PERMISSIONS;
  const rolesToCheck = ['consultant', 'actor', 'author', 'critic'] as const;
  const toolNames = [...NAMES.keys()];

  for (const role of rolesToCheck) {
    it(`${role}: the list of the adapters and layer 2 agree with the manifest`, () => {
      const base = policyOf(role);
      const granted = allowedPluginTools(NAMES, role, base, settings);
      const policy = withPluginTools(base, 'otheater', granted);

      for (const name of toolNames) {
        const expected = granted.includes(name);
        // The list Claude Code (`mcp__otheater__<name>`) and OpenCode (`otheater_<name>`) turn into
        // their rules (their packages test that), and the one layer 2 reads for Codex.
        expect(listOf(policy).includes(name), `list ${name}`).toBe(expected);
        const decision = decidePermission(
          {
            toolCallId: 'c1',
            title: name,
            options: [],
            mcpTool: { server: 'otheater', tool: name },
          },
          { ...policy },
          { cwd: '/work' },
        );
        expect(decision.decision, `codex ${name}`).toBe(expected ? 'allow' : 'reject');
        expect(decision.reason).toBe(expected ? 'mcp_tool_of_role' : 'mcp_tool_outside_role');
      }
    });
  }
});
