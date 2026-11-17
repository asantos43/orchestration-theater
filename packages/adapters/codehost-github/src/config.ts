// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/** Default ceiling for one `gh` or `git` command, in ms [proposta]. */
export const DEFAULT_GITHUB_TIMEOUT_MS = 120_000;

/**
 * Variables of the parent environment the tools get by default [proposta]: where the executables
 * are (`PATH`), where the credentials of `gh` and git live (`HOME`, the `GH_*` family, the token
 * variables, the ssh agent), the temporary directory and what Windows needs to start a process.
 * Everything else is dropped: the child is launched with a COMPLETE environment, as the
 * `ProcessLauncher` contract asks.
 */
export const DEFAULT_INHERITED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
];

/**
 * Configuration of the GitHub `CodeHost` adapter (`adapters.codehost: github`). Every default is
 * a key (project rule); the composition point passes the validated value to the adapter.
 * [proposta]
 */
export const GithubCodeHostConfigSchema = z.strictObject({
  /** The GitHub CLI; looked up in `PATH` when it is a bare name. */
  ghBinary: z.string().min(1).default('gh'),
  /** The git executable used to push and to read the remote. */
  gitBinary: z.string().min(1).default('git'),
  /** Ceiling for one command; past it the process tree is killed and the call fails `Transient`. */
  timeoutMs: z.int().min(1).max(3_600_000).default(DEFAULT_GITHUB_TIMEOUT_MS),
  /** Names of the parent's variables to pass on, besides the default list. */
  inheritEnv: z.array(z.string().min(1)).default([]),
  /** Variables set for the tools, over the inherited ones (a `GH_HOST`, a `GH_CONFIG_DIR`...). */
  env: z.record(z.string().min(1), z.string()).default({}),
});

export type GithubCodeHostConfigInput = z.input<typeof GithubCodeHostConfigSchema>;
export type GithubCodeHostConfig = z.output<typeof GithubCodeHostConfigSchema>;
