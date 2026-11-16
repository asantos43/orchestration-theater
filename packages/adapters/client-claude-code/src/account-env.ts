// SPDX-License-Identifier: MPL-2.0

/**
 * Variables that choose the account of Claude Code and win over the login of the profile: an
 * `ANTHROPIC_API_KEY` in the environment is used before the OAuth login of `CLAUDE_CONFIG_DIR`,
 * so one left in the environment of the daemon would make every profile bill the same account.
 * [S: the authentication precedence of the Claude Code documentation; not run here, because
 * running it needs a credential]
 */
export const ACCOUNT_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/**
 * What to do with {@link ACCOUNT_ENV_NAMES} found in the base environment. [proposta] key
 * `clients.claude-code.account_env`: `strip` (default) removes them; `keep` leaves them (the
 * operator wants one account for every profile).
 */
export const ACCOUNT_ENV_MODES = ['strip', 'keep'] as const;
export type AccountEnvMode = (typeof ACCOUNT_ENV_MODES)[number];

/** A copy of `env` without the account variables, unless `mode` is `keep`. Never reads a value. */
export function applyAccountEnv(
  env: Readonly<Record<string, string>>,
  mode: AccountEnvMode = 'strip',
): Record<string, string> {
  if (mode === 'keep') return { ...env };
  // Environment names are case-insensitive on Windows, so compare in upper case.
  const account = new Set<string>(ACCOUNT_ENV_NAMES);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !account.has(key.toUpperCase())));
}
