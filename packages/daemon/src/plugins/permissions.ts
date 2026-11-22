// SPDX-License-Identifier: MPL-2.0
import type { PluginToolManifest, RolePolicy, ToolEffectClass } from '@otheater/core';

/**
 * The permissions of the plugin tools, generated from the manifest (N237, architecture 5.8 and
 * 5.14; Phase 9, P6). A manifest says which roles see a tool and what the tool changes (`effects`);
 * it never opens anything the policy of the role closes. The rules, in this order:
 *
 * 1. the role is one the manifest lists for the tool (an empty list is the panel only);
 * 2. the effect fits the policy of the role (`effects` below); a tool has one effect;
 * 3. what is left is the list of names `<id>__<tool>` that goes into `RolePolicy.mcpTools.otheater`,
 *    so layer 1 (the client configuration of each adapter) and layer 2 (`decidePermission`) take it
 *    from the same field that already carries the framework tools, and into the grant of the
 *    server, which is the third door: a call to a name outside the list is refused there.
 *
 * Effects, with the modes of `plugins.permissions` [proposta]:
 * - `read`: any role the manifest lists. The Critic reads, so it gets these and nothing else.
 * - `local_write`: `writes` (default) needs `edit` or `write` in the `nativeTools` of the role;
 *   `shells` needs `nativeShell: shells`, as the framework shells (`restricted_shell`) do; `deny`
 *   gives no role such a tool.
 * - `network`: `network_allow` (default) needs a domain in `network.allow`, as `http_get` does;
 *   `any` gives it to every listed role; `deny` to none.
 * - `external_write`: `writes` (default) needs a role that writes (as `local_write`); `deny` to none.
 *
 * Approval: a tool with `requires_producer_approval: true` asks the Producer at every call; with
 * `external_write_approval: ask` (default) a tool with `external_write` asks too, whatever the
 * manifest says, so the manifest can only tighten that (`manifest` leaves it to the manifest).
 */

export const PLUGIN_LOCAL_WRITE_MODES = ['writes', 'shells', 'deny'] as const;
export const PLUGIN_NETWORK_MODES = ['network_allow', 'any', 'deny'] as const;
export const PLUGIN_EXTERNAL_WRITE_MODES = ['writes', 'deny'] as const;
export const PLUGIN_EXTERNAL_WRITE_APPROVAL_MODES = ['ask', 'manifest'] as const;
export const PLUGIN_APPROVAL_DETAIL_MODES = ['keys', 'values'] as const;

/** What `plugins.permissions` says, as plain values. */
export interface PluginPermissionSettings {
  readonly localWrite: (typeof PLUGIN_LOCAL_WRITE_MODES)[number];
  readonly network: (typeof PLUGIN_NETWORK_MODES)[number];
  readonly externalWrite: (typeof PLUGIN_EXTERNAL_WRITE_MODES)[number];
  readonly externalWriteApproval: (typeof PLUGIN_EXTERNAL_WRITE_APPROVAL_MODES)[number];
  readonly approvalDetail: (typeof PLUGIN_APPROVAL_DETAIL_MODES)[number];
}

/** The defaults of `plugins.permissions`, the same the configuration schema gives. */
export const DEFAULT_PLUGIN_PERMISSIONS: PluginPermissionSettings = {
  localWrite: 'writes',
  network: 'network_allow',
  externalWrite: 'writes',
  externalWriteApproval: 'ask',
  approvalDetail: 'keys',
};

/** The values of a parsed `plugins.permissions` section. */
export function pluginPermissionsFromConfig(section: {
  readonly local_write: PluginPermissionSettings['localWrite'];
  readonly network: PluginPermissionSettings['network'];
  readonly external_write: PluginPermissionSettings['externalWrite'];
  readonly external_write_approval: PluginPermissionSettings['externalWriteApproval'];
  readonly approval_detail: PluginPermissionSettings['approvalDetail'];
}): PluginPermissionSettings {
  return {
    localWrite: section.local_write,
    network: section.network,
    externalWrite: section.external_write,
    externalWriteApproval: section.external_write_approval,
    approvalDetail: section.approval_detail,
  };
}

/** The part of the policy of a role the effect rules read. */
export type PluginPolicyView = Pick<RolePolicy, 'nativeTools' | 'nativeShell' | 'network'>;

/** Why a tool is not allowed to a role; the values are stable (they reach a notice). */
export const PLUGIN_DENIAL_REASONS = [
  'role_not_listed',
  'role_cannot_write',
  'no_shell',
  'no_network',
  'denied_by_config',
] as const;
export type PluginDenialReason = (typeof PLUGIN_DENIAL_REASONS)[number];

export type PluginToolVerdict =
  | { readonly allowed: true; readonly approval: 'none' | 'manifest' | 'policy' }
  | { readonly allowed: false; readonly reason: PluginDenialReason };

/** True when the role can change files of its worktree: it has `edit` or `write` natively. */
function roleWrites(policy: PluginPolicyView): boolean {
  return policy.nativeTools.some((tool) => tool === 'edit' || tool === 'write');
}

function denial(
  effect: ToolEffectClass,
  policy: PluginPolicyView,
  settings: PluginPermissionSettings,
): PluginDenialReason | undefined {
  switch (effect) {
    case 'read':
      return undefined;
    case 'local_write':
      if (settings.localWrite === 'deny') return 'denied_by_config';
      if (settings.localWrite === 'shells')
        return policy.nativeShell === 'shells' ? undefined : 'no_shell';
      return roleWrites(policy) ? undefined : 'role_cannot_write';
    case 'network':
      if (settings.network === 'deny') return 'denied_by_config';
      if (settings.network === 'any') return undefined;
      return policy.network.allow.length > 0 ? undefined : 'no_network';
    case 'external_write':
      if (settings.externalWrite === 'deny') return 'denied_by_config';
      return roleWrites(policy) ? undefined : 'role_cannot_write';
  }
}

/** What the rules say of one tool for one role under its policy. */
export function judgePluginTool(
  tool: Pick<PluginToolManifest, 'roles' | 'effects' | 'requires_producer_approval'>,
  role: string,
  policy: PluginPolicyView,
  settings: PluginPermissionSettings,
): PluginToolVerdict {
  if (!(tool.roles as readonly string[]).includes(role)) {
    return { allowed: false, reason: 'role_not_listed' };
  }
  const reason = denial(tool.effects, policy, settings);
  if (reason !== undefined) return { allowed: false, reason };
  return { allowed: true, approval: approvalOf(tool, settings) };
}

/**
 * Whether a call waits for the Producer: `manifest` when the manifest asks for it, `policy` when
 * only `external_write_approval: ask` does, `none` otherwise. The manifest never lowers it.
 */
export function approvalOf(
  tool: Pick<PluginToolManifest, 'effects' | 'requires_producer_approval'>,
  settings: PluginPermissionSettings,
): 'none' | 'manifest' | 'policy' {
  if (tool.requires_producer_approval) return 'manifest';
  if (tool.effects === 'external_write' && settings.externalWriteApproval === 'ask')
    return 'policy';
  return 'none';
}

/** The names `<id>__<tool>` of `names` the role may call under its policy, in the order of `names`. */
export function allowedPluginTools(
  names: ReadonlyMap<string, { readonly tool: PluginToolManifest }>,
  role: string,
  policy: PluginPolicyView,
  settings: PluginPermissionSettings,
): string[] {
  const allowed: string[] = [];
  for (const [name, { tool }] of names) {
    if (judgePluginTool(tool, role, policy, settings).allowed) allowed.push(name);
  }
  return allowed;
}

/**
 * The policy with the allowed plugin tools in the list of the framework server (`otheater`), which
 * is where the three adapters and layer 2 read what an MCP tool of the role is. A policy that gives
 * the server whole (`all`) is left as it is; a policy that does not list the server has nothing to
 * add the tools to, so the plugin tools are not given either (fail closed).
 */
export function withPluginTools<P extends Pick<RolePolicy, 'mcpServers' | 'mcpTools'>>(
  policy: P,
  server: string,
  tools: readonly string[],
): P {
  if (tools.length === 0 || !policy.mcpServers.includes(server)) return policy;
  const listed = Object.hasOwn(policy.mcpTools, server) ? policy.mcpTools[server] : undefined;
  if (listed === 'all') return policy;
  const merged = [...new Set([...(listed ?? []), ...tools])];
  return { ...policy, mcpTools: { ...policy.mcpTools, [server]: merged } };
}
