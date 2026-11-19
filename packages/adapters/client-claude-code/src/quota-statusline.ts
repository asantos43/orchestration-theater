// SPDX-License-Identifier: MPL-2.0
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AdapterUnavailable, Transient, type QuotaReading, type QuotaWindow } from '@otheater/core';
import { readUtilization, STATUSLINE_WINDOWS, windowNameOf } from './normalize-update.js';

/**
 * The quota source of a Claude Code subscription (architecture 5.6, P6): the statusline. Claude
 * Code hands the statusline command a JSON on stdin that carries `rate_limits.five_hour` and
 * `rate_limits.seven_day`, each with `used_percentage` (0..100, an integer in Phase 0) and
 * `resets_at` (epoch seconds). The command OTheater installs keeps only those numbers in a file of
 * the profile directory; the probe reads that file. [V: Phase 0 item 1, claude 2.1.x]
 *
 * What is [N]: whether a session driven through ACP (the Agent SDK) runs the statusline at all,
 * and whether the `statusLine` of the profile `settings.json` is read when `settingSources` is
 * `none`. Phase 0 measured the statusline of the interactive client with `--settings`. Without a
 * run of the command there is no file, and the profile stays `unknown`, which is the safe side.
 */

/** The statusline command, written next to the settings. The only code of ours in the profile. */
export const STATUSLINE_SCRIPT_FILE = 'otheater-statusline.mjs';
/** What the command writes and the probe reads: the quota numbers and the time of the write. */
export const STATUSLINE_QUOTA_FILE = 'otheater-quota.json';
/** `version` of {@link STATUSLINE_QUOTA_FILE}. */
export const STATUSLINE_QUOTA_VERSION = 1;
/** The file is a few hundred bytes; a bigger one is not ours. */
export const STATUSLINE_QUOTA_MAX_BYTES = 16 * 1024;

/** `clients.claude-code.quota_statusline`. [proposta] */
export const QUOTA_STATUSLINE_MODES = ['file', 'off'] as const;
export type QuotaStatuslineMode = (typeof QUOTA_STATUSLINE_MODES)[number];

// The window names live with the stream parser, which needs them too; the statusline keeps them in its API.
export { STATUSLINE_WINDOWS, windowNameOf };

/**
 * The statusline command. It reads stdin, keeps `used_percentage` and `resets_at` of the two
 * windows and nothing else of the input (no session id, no path, no model, no account), and
 * replaces the quota file atomically. It does not start a process, does not open a socket, does
 * not read any file and prints nothing: the status bar stays empty. A stdin without
 * `rate_limits` (the first call, before the first reply) leaves the last file as it is, so a reading
 * is never replaced by a blank. Any error is swallowed: a statusline must never break the client.
 */
export const STATUSLINE_SCRIPT = `// Written by OTheater. Do not edit: it is rewritten whenever a session of this profile starts.
// Keeps the quota numbers of the statusline input in ${STATUSLINE_QUOTA_FILE}. No network, no model.
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT = 1048576;
const target = join(dirname(fileURLToPath(import.meta.url)), '${STATUSLINE_QUOTA_FILE}');
const chunks = [];
let size = 0;
process.stdin.on('data', (chunk) => {
  size += chunk.length;
  if (size <= MAX_INPUT) chunks.push(chunk);
});
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const temporary = target + '.' + String(process.pid) + '.tmp';
  try {
    if (size > MAX_INPUT) return;
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const limits = input !== null && typeof input === 'object' ? input.rate_limits : undefined;
    if (limits === null || typeof limits !== 'object') return;
    const kept = {};
    for (const name of ['five_hour', 'seven_day']) {
      const window = limits[name];
      if (window === null || typeof window !== 'object') continue;
      const entry = {};
      if (typeof window.used_percentage === 'number' && Number.isFinite(window.used_percentage)) {
        entry.used_percentage = window.used_percentage;
      }
      if (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at)) {
        entry.resets_at = window.resets_at;
      }
      if (Object.keys(entry).length > 0) kept[name] = entry;
    }
    if (Object.keys(kept).length === 0) return;
    const body = { version: ${String(STATUSLINE_QUOTA_VERSION)}, observed_at: Date.now(), rate_limits: kept };
    writeFileSync(temporary, JSON.stringify(body) + '\\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {}
  }
});
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `statusLine` setting that runs {@link STATUSLINE_SCRIPT}: `{ type: 'command', command }`.
 * `node` is the one that runs the daemon unless the caller says another; both paths are quoted
 * for `sh`. The path is not part of any file of the repository: it is written at run time.
 */
export function statuslineSetting(
  profileDir: string,
  nodePath: string = process.execPath,
): { type: 'command'; command: string } {
  return {
    type: 'command',
    command: `${shellQuote(nodePath)} ${shellQuote(join(profileDir, STATUSLINE_SCRIPT_FILE))}`,
  };
}

/** Whether a `statusLine` value is the one {@link statuslineSetting} writes (it names our script). */
export function isOurStatusline(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(STATUSLINE_SCRIPT_FILE);
}

// ---- reading ----

/** What the quota file said, with the unit the numbers had. */
export type StatuslineParse =
  | { readonly ok: true; readonly reading: QuotaReading; readonly unit: 'percent' }
  | { readonly ok: false; readonly reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Turns the text of the quota file into a reading, at the instant `now` (epoch ms).
 *
 * - `used_percentage` is a percentage: a value that is not a number, or that falls outside 0..100,
 *   refuses the whole file with the reason. It is never clamped (N123).
 * - `resets_at` is epoch seconds. A window whose reset has passed is dropped, as Claude Code does
 *   itself: its number belongs to a window that ended.
 * - No window left (no `rate_limits`, all of them over) refuses with the reason, and the profile
 *   is `unknown`; there is no "zero use" to infer from the lack of a window.
 * - `observedAt` is the time the command wrote the file, never later than `now`.
 */
export function parseStatuslineQuota(text: string, now: number): StatuslineParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the quota file is not valid JSON' };
  }
  const root = record(json);
  if (root === undefined) return { ok: false, reason: 'the quota file is not a JSON object' };
  if (root.version !== STATUSLINE_QUOTA_VERSION) {
    return { ok: false, reason: `the quota file has an unknown version (${String(root.version)})` };
  }
  const observed = root.observed_at;
  if (typeof observed !== 'number' || !Number.isInteger(observed) || observed < 0) {
    return { ok: false, reason: 'the quota file has no valid observed_at' };
  }
  const limits = record(root.rate_limits);
  if (limits === undefined) return { ok: false, reason: 'the quota file has no rate_limits' };

  const windows: QuotaWindow[] = [];
  for (const [claudeName, name] of Object.entries(STATUSLINE_WINDOWS)) {
    const raw = limits[claudeName];
    if (raw === undefined) continue;
    const entry = record(raw);
    if (entry === undefined)
      return { ok: false, reason: `rate_limits.${claudeName} is not an object` };
    const used = readUtilization(entry.used_percentage, 'percent');
    if (!used.ok) {
      return { ok: false, reason: `rate_limits.${claudeName}.used_percentage: ${used.reason}` };
    }
    let resetsAt: number | undefined;
    if (entry.resets_at !== undefined) {
      const seconds = entry.resets_at;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        return { ok: false, reason: `rate_limits.${claudeName}.resets_at is not a time` };
      }
      resetsAt = Math.round(seconds * 1000);
      if (resetsAt <= now) continue;
    }
    windows.push({
      window: name,
      usedPercent: used.percent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (windows.length === 0) {
    return { ok: false, reason: 'the quota file has no window that is still open' };
  }
  return { ok: true, unit: 'percent', reading: { observedAt: Math.min(observed, now), windows } };
}

/**
 * Reads the quota file of a profile directory without following a symbolic link. The file is
 * opened with `O_NOFOLLOW`, must be a regular file with one link, no bigger than
 * {@link STATUSLINE_QUOTA_MAX_BYTES}, and its real path must stay inside the real profile directory
 * (the directory itself may be a link: that is the operator's choice). Rejects with
 * `AdapterUnavailable` when there is no usable file (the profile is `unknown`) and with `Transient`
 * for an I/O error that may pass.
 */
export async function readStatuslineFile(profileDir: string): Promise<string> {
  const file = join(profileDir, STATUSLINE_QUOTA_FILE);
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) {
      throw new AdapterUnavailable('the Claude statusline has not written a quota file yet', {
        cause: error,
      });
    }
    throw new Transient('the quota file could not be inspected', { cause: error });
  }
  if (info.isSymbolicLink()) {
    throw new AdapterUnavailable('the quota file is a symbolic link; it was not read');
  }
  if (!info.isFile() || info.nlink > 1) {
    throw new AdapterUnavailable(
      'the quota file is not a plain file with one link; it was not read',
    );
  }
  try {
    const [realDir, realFile] = await Promise.all([realpath(profileDir), realpath(file)]);
    if (!realFile.startsWith(realDir + sep)) {
      throw new AdapterUnavailable('the quota file resolves outside the profile; it was not read');
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.ino !== info.ino) {
        throw new AdapterUnavailable('the quota file changed while it was opened; it was not read');
      }
      if (opened.size > STATUSLINE_QUOTA_MAX_BYTES) {
        throw new AdapterUnavailable('the quota file is too big to be ours; it was not read');
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof AdapterUnavailable) throw error;
    if (isCode(error, 'ELOOP')) {
      throw new AdapterUnavailable('the quota file is a symbolic link; it was not read', {
        cause: error,
      });
    }
    if (isCode(error, 'ENOENT')) {
      throw new AdapterUnavailable('the Claude statusline has not written a quota file yet', {
        cause: error,
      });
    }
    throw new Transient('the quota file could not be read', { cause: error });
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
