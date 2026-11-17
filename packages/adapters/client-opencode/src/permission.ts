// SPDX-License-Identifier: MPL-2.0
import { mcpToolsOf, type RolePolicy } from '@otheater/core';

/** What OpenCode does with a tool call: run it, ask (`session/request_permission`) or remove it. */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/**
 * The value of `OPENCODE_PERMISSION`: one action per tool key. The order of the keys matters, the
 * last rule that matches wins, so `"*"` is always first (measured in Phase 0, item 8d [V]).
 */
export type PermissionRules = Readonly<Record<string, PermissionAction>>;

/**
 * Keys that name the shell tool. Version 1.19.5 (the one measured in Phase 0) answers to `bash`
 * [V]; the V2 docs call it `shell` [S, `shell` untested here, so [N] for 1.19.5]. [proposta] key
 * `clients.opencode.shell_keys`; a client upgrade to V2 would set `['bash', 'shell']`.
 */
export const DEFAULT_SHELL_KEYS: readonly string[] = ['bash'];

/** Tools of OpenCode that the four native tools of a role stand for (permission docs [S]). */
const SEARCH_TOOLS = ['glob', 'grep', 'list'] as const;

/**
 * Tools that are not among the native tools of a role (`read`, `search`, `edit`, `write`): the
 * role does not get them. Names come from the OpenCode permission docs [S]; none was measured in
 * Phase 0 [N], which is why the real test opens a session with this very environment.
 */
const REMOVED_TOOLS = ['task', 'webfetch', 'websearch', 'skill'] as const;

export interface PermissionOptions {
  /** Default {@link DEFAULT_SHELL_KEYS}. */
  readonly shellKeys?: readonly string[];
}

/**
 * Prefix OpenCode gives the tools of an MCP server: `<servername>_<tool>` [V, Phase 0]. Characters
 * outside `[A-Za-z0-9_-]` are turned into `_` (the rule OpenCode applies to the name is [N]).
 */
export function mcpToolPrefix(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Translates the neutral policy of a role into the rules of `OPENCODE_PERMISSION` (architecture
 * 5.2, translation table). Pure.
 *
 * - `nativeTools`: each tool the role has is `allow`; the others are `deny`, which removes the
 *   tool (measured for the shell: "Invalid Tool", Phase 0 [V]; for the other keys [N]).
 * - `nativeShell: none`: the shell keys are `deny`.
 * - `mcpServers` and `mcpTools`: each tool the role may call is `allow` by name
 *   (`<server>_<tool>`), or `<server>_*` for a server whose tools are `all`; the other tools of the
 *   server fall under the default `ask`, which layer 2 rejects (`mcpServers` is strict: an unnamed
 *   server is not in the session).
 * - `nativeShell: shells`: the shell of the client stays `deny`; the shells of the daemon are MCP
 *   tools and come in with `mcpTools`.
 * - `onAsk: reject`: the default for everything else is `ask`; layer 2 (`answerPermission` of the
 *   base) answers `reject_once`.
 * - `bypass: forbidden`: there is no bypass through ACP; the pinned variable is what stops an
 *   `opencode.json` of the worktree from loosening any of this.
 * - `writeScope: worktree`: `external_directory` is `deny` (the V2 docs say it is allowed by
 *   default [S]); layer 3 is the other half.
 */
export function opencodePermission(
  policy: RolePolicy,
  options: PermissionOptions = {},
): PermissionRules {
  const tools = new Set<string>(policy.nativeTools);
  const rules: Record<string, PermissionAction> = { '*': 'ask' };
  rules.read = tools.has('read') ? 'allow' : 'deny';
  for (const tool of SEARCH_TOOLS) rules[tool] = tools.has('search') ? 'allow' : 'deny';
  rules.edit = tools.has('edit') || tools.has('write') ? 'allow' : 'deny';
  for (const key of options.shellKeys ?? DEFAULT_SHELL_KEYS) rules[key] = 'deny';
  rules.external_directory = 'deny';
  for (const tool of REMOVED_TOOLS) rules[tool] = 'deny';
  for (const server of policy.mcpServers) {
    const prefix = mcpToolPrefix(server);
    const named = mcpToolsOf(policy, server);
    if (named === 'all') rules[`${prefix}_*`] = 'allow';
    else for (const tool of named) rules[`${prefix}_${mcpToolPrefix(tool)}`] = 'allow';
  }
  return rules;
}

/** The text of `OPENCODE_PERMISSION`. */
export function serializePermission(rules: PermissionRules): string {
  return JSON.stringify(rules);
}

/**
 * What `profileEnv` uses when no policy is at hand: nothing is allowed. A client started this way
 * can read nothing and change nothing, so a missing policy fails closed.
 */
export const DENY_ALL_POLICY: RolePolicy = {
  nativeTools: [],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};
