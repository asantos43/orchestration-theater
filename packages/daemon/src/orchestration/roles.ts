// SPDX-License-Identifier: MPL-2.0
import type { ExecutorConfig, Profile, RolePolicy } from '@otheater/core';
import type { DaemonConfig, PlayExecutor } from '../config.js';
import { FRAMEWORK_MCP_NAME } from '../mcp/access.js';
import { profileDirOf, type DataPaths } from '../paths.js';

/**
 * [proposta] Which Executor runs a role: `orchestration.roles.<role>` when set, otherwise
 * `orchestration.executor`. The architecture leaves the choice of the Executor per role to the
 * Director's policy (5.4, 5.6); until that exists, the configuration says it. `undefined` means
 * nothing is configured, and the caller refuses to start the work with a message that says so.
 */
export function executorOf(config: DaemonConfig, role: string): PlayExecutor | undefined {
  return config.orchestration.roles[role] ?? config.orchestration.executor;
}

/** The profile and the executor settings of a configured Executor. */
export function sessionSettingsOf(
  paths: Pick<DataPaths, 'profiles'>,
  executor: PlayExecutor,
): { readonly profile: Profile; readonly executor: ExecutorConfig } {
  const { client, profile: name, model, effort, mode } = executor;
  return {
    profile: {
      client,
      profile: name,
      id: `${client}/${name}`,
      dir: profileDirOf(paths, { client, profile: name }),
    },
    executor: {
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(mode === undefined ? {} : { mode }),
    },
  };
}

/** Roles that write in their worktree; every other role only reads (5.4, "Fronteira de cada papel"). */
const WRITING_ROLES: ReadonlySet<string> = new Set(['actor']);

/**
 * [proposta] The tool policy of a role: the Actor edits and writes inside its worktree, the others
 * only read and search; nobody gets a shell, a way past a permission or the network (the
 * framework MCP server is their only door, 5.3). Fixed in code until the policy per role has
 * a configuration of its own.
 */
export function policyOf(role: string): RolePolicy {
  return {
    nativeTools: WRITING_ROLES.has(role) ? ['read', 'search', 'edit', 'write'] : ['read', 'search'],
    nativeShell: 'none',
    mcpServers: [FRAMEWORK_MCP_NAME],
    onAsk: 'reject',
    bypass: 'forbidden',
    writeScope: 'worktree',
    network: { allow: [] },
  };
}
