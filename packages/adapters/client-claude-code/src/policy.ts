// SPDX-License-Identifier: MPL-2.0
import type { RolePolicy } from '@otheater/core';

/**
 * Translation of the neutral `RolePolicy` into the keys of Claude Code (architecture 5.2, table
 * "Tradução da RolePolicy"; 5.8, layer 1). Everything here is pure data in, data out. The facts
 * behind each key, with the source of each:
 *
 * - `tools` removes a tool from the session; `disallowedTools` and a `permissions.deny` rule for a
 *   whole tool do the same, each on its own. [V: Phase 0, `s10-permissions-isolated.ts`, `claude`
 *   2.1.325, adapter 0.107.0]
 * - `allowDangerouslySkipPermissions: false` takes `bypassPermissions` out of the mode catalog.
 *   [V: same run]
 * - `settingSources: []` drops the plugins, skills and MCP servers of the user's profile. [V]
 * - `permissions.defaultMode` in `_meta` is ignored: the mode belongs to ACP and starts at `auto`,
 *   so the session setup sets `default` explicitly. [V]
 */

/** Names of the native tools of Claude Code this adapter knows how to grant. [V: init tool list, Phase 0 item 8] */
export const CLAUDE_TOOL_NAMES = {
  read: ['Read'],
  search: ['Glob', 'Grep'],
  edit: ['Edit'],
  write: ['Write'],
} as const satisfies Record<RolePolicy['nativeTools'][number], readonly string[]>;

/** The native shell of Claude Code. `nativeShell: 'none'` (the only value of version 1) removes it. */
export const CLAUDE_SHELL_TOOL = 'Bash';

/** Every tool name the policy decides about, in a fixed order. */
const MANAGED_TOOLS: readonly string[] = [
  ...Object.values(CLAUDE_TOOL_NAMES).flat(),
  CLAUDE_SHELL_TOOL,
];

/**
 * Where Claude Code reads its settings from: the value of `clients.claude-code.setting_sources`.
 * [proposta] `none` is the default (architecture 5.8, v0.45).
 */
export const SETTING_SOURCES_MODES = ['none', 'project', 'user'] as const;
export type SettingSourcesMode = (typeof SETTING_SOURCES_MODES)[number];

/** `settingSources` of the Agent SDK for each mode of `clients.claude-code.setting_sources`. */
export const SETTING_SOURCES: Readonly<Record<SettingSourcesMode, readonly string[]>> = {
  none: [],
  project: ['project'],
  user: ['user', 'project', 'local'],
};

/** The mode every session starts in: `default`, so each request reaches layer 2 (`dontAsk` does not reach ACP). [V] */
export const SESSION_MODE = 'default';

/** Modes the catalog of the adapter has that the policy never selects. */
export const FORBIDDEN_MODES: readonly string[] = ['bypassPermissions'];

/** The tools of the policy, in a stable order, without repeats. Never contains the shell. */
export function allowedTools(policy: RolePolicy): string[] {
  const names = new Set<string>();
  for (const category of policy.nativeTools) {
    for (const name of CLAUDE_TOOL_NAMES[category]) names.add(name);
  }
  return MANAGED_TOOLS.filter((name) => names.has(name));
}

/** The managed tools the policy does not grant, shell first: the second layer next to `tools`. */
export function deniedTools(policy: RolePolicy): string[] {
  const allowed = new Set(allowedTools(policy));
  return [
    CLAUDE_SHELL_TOOL,
    ...MANAGED_TOOLS.filter((name) => name !== CLAUDE_SHELL_TOOL && !allowed.has(name)),
  ];
}

/** True for the names of {@link MANAGED_TOOLS}: `prepareProfile` owns these entries of `deny`. */
export function isManagedToolName(entry: unknown): boolean {
  return typeof entry === 'string' && MANAGED_TOOLS.includes(entry);
}

/** The permission keys that go to a `settings.json` (the profile file) and to `_meta` alike. */
export function permissionSettings(policy: RolePolicy): {
  disableBypassPermissionsMode: 'disable';
  deny: string[];
} {
  return { disableBypassPermissionsMode: 'disable', deny: deniedTools(policy) };
}

/** `_meta.claudeCode.options` of `session/new` (the `via: 'acp'` setup). */
export interface ClaudeAcpOptions {
  readonly tools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly strictMcpConfig: true;
  readonly allowDangerouslySkipPermissions: false;
  readonly settingSources: readonly string[];
  readonly settings: { readonly permissions: ReturnType<typeof permissionSettings> };
}

export function acpOptions(policy: RolePolicy, sources: SettingSourcesMode): ClaudeAcpOptions {
  return {
    tools: allowedTools(policy),
    disallowedTools: deniedTools(policy),
    strictMcpConfig: true,
    allowDangerouslySkipPermissions: false,
    settingSources: [...SETTING_SOURCES[sources]],
    settings: { permissions: permissionSettings(policy) },
  };
}

/**
 * The flags of `claude -p --output-format stream-json` (the emergency exit). The flag names come
 * from `docs/08` part 2, checked against `--help` of 2.1.319 on 2026-11-08 [V], except
 * `--setting-sources` and `--verbose` (stream-json needs it with `-p`), which are not in that
 * table [N]: they come from the public CLI reference. Nothing here ran against the real client.
 */
export function headlessArgs(policy: RolePolicy, sources: SettingSourcesMode): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--tools',
    allowedTools(policy).join(','),
    '--disallowedTools',
    deniedTools(policy).join(','),
    '--permission-mode',
    SESSION_MODE,
    // `host`: with `--print`, the host (the daemon, layer 2) answers the requests, not a terminal.
    '--permission-prompts',
    'host',
    '--setting-sources',
    SETTING_SOURCES[sources].join(','),
  ];
}
