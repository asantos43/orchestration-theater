// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { InvalidInput } from '@otheater/core';

/** Where the client keeps the login of a profile (`cli_auth_credentials_store`, docs/08). */
export const CREDENTIALS_STORES = ['file', 'keyring', 'auto'] as const;
export type CredentialsStore = (typeof CREDENTIALS_STORES)[number];

/**
 * `approval_policy` values the adapter writes. `never` is not among them: it would turn every
 * escalation into a silent failure that the daemon cannot see, instead of a request it refuses.
 */
export const APPROVAL_POLICIES = ['on-request', 'untrusted'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export interface ProfileConfig {
  readonly credentialsStore: CredentialsStore;
  readonly sandboxMode: 'read-only' | 'workspace-write';
  readonly approvalPolicy: ApprovalPolicy;
}

/** The only file of the profile the adapter writes. */
export const CONFIG_FILE = 'config.toml';

const HEADER = '# Written by OTheater (adapter-client-codex). Changes here are overwritten.\n';

/**
 * The `config.toml` of a profile (docs/08, "Permissões gravadas pelo prepareProfile"). Three keys,
 * each a plain string from a closed list. No MCP server is written: the servers of a role reach
 * the session through `session/new`, and the profile has none of its own. No credential is
 * written, and none is read.
 */
export function renderConfigToml(config: ProfileConfig): string {
  return (
    HEADER +
    `cli_auth_credentials_store = ${JSON.stringify(config.credentialsStore)}\n` +
    `sandbox_mode = ${JSON.stringify(config.sandboxMode)}\n` +
    `approval_policy = ${JSON.stringify(config.approvalPolicy)}\n`
  );
}

/**
 * Writes `<dir>/config.toml`, and nothing else: the credentials of the profile (the files the client keeps
 * next to it) are never opened. The file is replaced through a
 * temporary file in the same directory, so a reader never sees half of it, and it is not touched
 * when it already has the right content.
 */
export async function writeProfileConfig(dir: string, config: ProfileConfig): Promise<void> {
  if (!isAbsolute(dir))
    throw new InvalidInput(`codex: the profile directory must be absolute: ${dir}`);
  const target = join(dir, CONFIG_FILE);
  const content = renderConfigToml(config);
  await mkdir(dir, { recursive: true });
  try {
    if ((await readFile(target, 'utf8')) === content) return;
  } catch {
    // Missing, or not readable as text: written below.
  }
  const temporary = join(dir, `${CONFIG_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
