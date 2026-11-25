// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput, type Profile, type RolePolicy } from '@otheater/core';
import { isManagedToolName, permissionSettings, sessionModeOf } from './policy.js';
import {
  isOurStatusline,
  STATUSLINE_QUOTA_FILE,
  STATUSLINE_SCRIPT,
  STATUSLINE_SCRIPT_FILE,
  statuslineSetting,
  type QuotaStatuslineMode,
} from './quota-statusline.js';
import { sweepTemporaries, temporaryPathOf } from './temporaries.js';

/** The one file this adapter writes in the profile directory. Never a credential file. */
export const PROFILE_SETTINGS_FILE = 'settings.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new InvalidInput(`${path} is not valid JSON; it was left as it is`, { cause });
  }
  if (!isRecord(parsed)) {
    throw new InvalidInput(`${path} is not a JSON object; it was left as it is`);
  }
  return parsed;
}

export interface ProfileSettingsOptions {
  /**
   * [proposta] key `clients.claude-code.quota_statusline`. `file` (default): the settings get a
   * `statusLine` command that keeps the quota numbers in the profile directory (P6) and the script
   * is written next to them. `off`: no command; a `statusLine` that is ours is taken out.
   */
  readonly quotaStatusline?: QuotaStatuslineMode;
  /** The `node` that runs the statusline script. Default: the one that runs the daemon. */
  readonly nodePath?: string;
}

/** The temporary of {@link writeAtomically}: `<file>.<pid>.<8 hex>.tmp` (N306). */
export const PROFILE_TEMPORARY_SHAPE = {
  hexLength: 8,
  // Before N306 the name was `<file>.<pid>.tmp`: it has a pid, so it follows the policy.
  legacy: [{ suffix: 'pid' }],
} as const;
/** The temporary the statusline script writes: `otheater-quota.json.<pid>.tmp` (its own process). */
export const QUOTA_TEMPORARY_SHAPE = { hexLength: 0 } as const;

/**
 * Temporary file, then rename. A process killed in between leaves the temporary, so after the write
 * the orphans of this file are removed (N306); a failure to remove one never fails the write.
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = temporaryPathOf(path, PROFILE_TEMPORARY_SHAPE);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await sweepTemporaries(path, PROFILE_TEMPORARY_SHAPE);
}

/**
 * Layer 1 in a file (architecture 5.8): writes the permission keys of the policy into the
 * `settings.json` of the profile directory (`CLAUDE_CONFIG_DIR`). The adapter reads the settings
 * files to build the mode catalog and the initial mode, and `disableBypassPermissionsMode` in a
 * file takes `bypassPermissions` out of the catalog, which the same key in `_meta` does not. [V:
 * Phase 0 item 8b]
 *
 * It touches three keys under `permissions` and nothing else: `defaultMode`,
 * `disableBypassPermissionsMode` and the bare tool names in `deny` that this adapter manages
 * (the others in `deny`, and every other key of the file, stay). It never opens another file of
 * the directory: the credentials of the client live there and are not ours
 * to read. The write is atomic (temporary file, then rename). A file that is not a JSON object is
 * left alone and the call rejects with `InvalidInput`.
 *
 * With `quotaStatusline: 'file'` (the default) it also owns the `statusLine` key and writes the
 * script it points to ({@link STATUSLINE_SCRIPT_FILE}); that script is the only other file this
 * function creates. The statusline of the profile settings wins over any other one only if the
 * client reads it; Phase 0 measured that for `--settings` [V], not for the settings of
 * `CLAUDE_CONFIG_DIR` with `settingSources` `none` [N].
 */
export async function writeProfileSettings(
  profile: Profile,
  policy: RolePolicy,
  options: ProfileSettingsOptions = {},
): Promise<void> {
  const path = join(profile.dir, PROFILE_SETTINGS_FILE);
  await mkdir(profile.dir, { recursive: true });
  const settings = await readSettings(path);
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const wanted = permissionSettings(policy);
  const kept = Array.isArray(permissions.deny)
    ? (permissions.deny as unknown[]).filter((entry) => !isManagedToolName(entry))
    : [];
  const { statusLine: previous, ...others } = settings;
  const mode = options.quotaStatusline ?? 'file';
  let statusLine: unknown;
  if (mode === 'file') {
    statusLine = statuslineSetting(profile.dir, options.nodePath);
    await writeAtomically(join(profile.dir, STATUSLINE_SCRIPT_FILE), STATUSLINE_SCRIPT);
  } else if (previous !== undefined && !isOurStatusline(previous)) {
    statusLine = previous;
  }
  const next = {
    ...others,
    permissions: {
      ...permissions,
      defaultMode: sessionModeOf(policy),
      disableBypassPermissionsMode: wanted.disableBypassPermissionsMode,
      deny: [...kept, ...wanted.deny],
    },
    ...(statusLine === undefined ? {} : { statusLine }),
  };
  await writeAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
  // The statusline runs in processes of the client, and one killed between its write and its rename
  // leaves `otheater-quota.json.<pid>.tmp`; a session start is when this adapter can take it away.
  await sweepTemporaries(join(profile.dir, STATUSLINE_QUOTA_FILE), QUOTA_TEMPORARY_SHAPE);
}
