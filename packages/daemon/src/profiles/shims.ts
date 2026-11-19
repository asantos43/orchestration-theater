// SPDX-License-Identifier: MPL-2.0
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Env } from '../paths.js';

/**
 * The commands by profile (Phase 5, P28b, N159; owner, 2026-11-19): one small script per profile,
 * `<prefix><client>-<profile>` (`codex-personal`), in the `bin` folder of the data directory. The
 * script only calls `ot profile exec <client>/<profile> -- "$@"`, with the absolute paths of Node and
 * of `ot`, and the data directory; no secret is in it. `ot profile exec` builds the environment.
 *
 * Owner's decisions: the prefix is configurable and empty by default; a name that some other
 * program already has in `PATH` is not created, with a warning; putting the folder in `PATH` is the
 * person's choice: `ot profile shims path` shows the line, and `--install` writes it in the shell's
 * rc file, in a marked block, only after a yes.
 */

/** The line every script carries, so a sync only ever removes what it wrote. */
export const SHIM_MARKER = 'otheater-profile-shim';

/** What runs `ot`: the Node binary and the entry script, both absolute. */
export interface OtLauncher {
  readonly node: string;
  readonly entry: string;
}

export type ShimPlatform = 'posix' | 'win32';

export function shimPlatformOf(platform: NodeJS.Platform): ShimPlatform {
  return platform === 'win32' ? 'win32' : 'posix';
}

/** The command name of a profile; the file is this, plus `.cmd` on Windows. */
export function shimNameOf(prefix: string, client: string, profile: string): string {
  return `${prefix}${client}-${profile}`;
}

export function shimFileOf(name: string, platform: ShimPlatform): string {
  return platform === 'win32' ? `${name}.cmd` : name;
}

/** `'...'` for `sh`, with every `'` closed, escaped and reopened. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `"..."` for `cmd.exe`; a `"` or a `%` in a path is refused before this. */
function cmdQuote(value: string): string {
  return `"${value}"`;
}

/** The text of one script. */
export function shimContent(
  platform: ShimPlatform,
  launcher: OtLauncher,
  dataDir: string,
  profileId: string,
): string {
  if (platform === 'win32') {
    for (const value of [launcher.node, launcher.entry, dataDir, profileId]) {
      if (/["%\r\n]/.test(value)) throw new Error(`cannot quote ${JSON.stringify(value)} for cmd`);
    }
    return [
      '@echo off',
      `rem ${SHIM_MARKER}: runs ${profileId} through "ot profile exec"; it holds no secret.`,
      `${cmdQuote(launcher.node)} ${cmdQuote(launcher.entry)} --data-dir ${cmdQuote(dataDir)} profile exec ${cmdQuote(profileId)} -- %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}: runs ${profileId} through "ot profile exec"; it holds no secret.`,
    `exec ${shQuote(launcher.node)} ${shQuote(launcher.entry)} --data-dir ${shQuote(dataDir)} profile exec ${shQuote(profileId)} -- "$@"`,
    '',
  ].join('\n');
}

/** The folders of `PATH`, in order, without the empty ones. */
export function pathEntriesOf(env: Env, platform: ShimPlatform): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  // The separator is the one of the platform asked, not of the host: `path.delimiter` is `;` on a
  // Windows host, and a POSIX PATH split there would come out whole.
  return raw.split(platform === 'win32' ? ';' : ':').filter((entry) => entry !== '');
}

async function isExecutable(file: string, platform: ShimPlatform): Promise<boolean> {
  try {
    await access(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where else in `PATH` the name already is, outside `binDir`: the first match, or `undefined`. On
 * Windows the extensions of `PATHEXT` count too.
 */
export async function findOnPath(
  name: string,
  env: Env,
  platform: ShimPlatform,
  binDir: string,
): Promise<string | undefined> {
  const own = resolve(binDir);
  const extensions =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')]
      : [''];
  for (const entry of pathEntriesOf(env, platform)) {
    const folder = resolve(entry);
    if (platform === 'win32' ? folder.toLowerCase() === own.toLowerCase() : folder === own) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(folder, `${name}${extension}`);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** Whether `binDir` is in `PATH` now. */
export function binOnPath(env: Env, platform: ShimPlatform, binDir: string): boolean {
  const own = resolve(binDir);
  return pathEntriesOf(env, platform).some((entry) =>
    platform === 'win32'
      ? resolve(entry).toLowerCase() === own.toLowerCase()
      : resolve(entry) === own,
  );
}

export interface ShimProfile {
  readonly id: string;
  readonly client: string;
  readonly name: string;
}

export interface ShimSyncInput {
  readonly binDir: string;
  readonly dataDir: string;
  readonly prefix: string;
  readonly launcher: OtLauncher;
  readonly platform: ShimPlatform;
  readonly env: Env;
  /** The profiles that get a script: every one not `removed`. */
  readonly profiles: readonly ShimProfile[];
}

export interface ShimConflict {
  readonly profileId: string;
  readonly name: string;
  /** Where the other program with that name is. */
  readonly at: string;
}

export interface ShimSyncResult {
  readonly binDir: string;
  /** Written now: new, or with a text that changed. */
  readonly written: readonly string[];
  /** Already there, with the same text. */
  readonly kept: readonly string[];
  /** Scripts of this daemon that no profile has any more. */
  readonly removed: readonly string[];
  readonly conflicts: readonly ShimConflict[];
}

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Makes `binDir` hold exactly one script per profile: writes the missing or changed ones, removes
 * the scripts of this daemon that no profile has, and leaves alone any file without
 * {@link SHIM_MARKER}. A name already in `PATH` outside `binDir` is a conflict: no script, and its
 * own old script, if any, is removed so the other program wins as it did before.
 */
export async function syncShims(input: ShimSyncInput): Promise<ShimSyncResult> {
  const { binDir, platform } = input;
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  const kept: string[] = [];
  const removed: string[] = [];
  const conflicts: ShimConflict[] = [];
  const wanted = new Set<string>();

  for (const profile of input.profiles) {
    const name = shimNameOf(input.prefix, profile.client, profile.name);
    const file = join(binDir, shimFileOf(name, platform));
    const other = await findOnPath(name, input.env, platform, binDir);
    if (other !== undefined) {
      conflicts.push({ profileId: profile.id, name, at: other });
      continue;
    }
    wanted.add(basename(file));
    const content = shimContent(platform, input.launcher, input.dataDir, profile.id);
    if ((await readOrUndefined(file)) === content) {
      kept.push(name);
      continue;
    }
    const temporary = join(dirname(file), `.${basename(file)}.${String(process.pid)}.tmp`);
    await writeFile(temporary, content, { mode: 0o700 });
    if (platform === 'posix') await chmod(temporary, 0o700);
    await rename(temporary, file);
    written.push(name);
  }

  for (const entry of await readdir(binDir)) {
    if (wanted.has(entry) || entry.startsWith('.')) continue;
    const file = join(binDir, entry);
    const text = await readOrUndefined(file);
    if (text?.includes(SHIM_MARKER) !== true) continue;
    await rm(file, { force: true });
    removed.push(platform === 'win32' ? entry.replace(/\.cmd$/i, '') : entry);
  }
  return { binDir, written, kept, removed, conflicts };
}

// ---------------------------------------------------------------------------------------------
// The rc file of the shell.

export type RcShell = 'zsh' | 'bash' | 'fish';
export const RC_SHELLS: readonly RcShell[] = ['zsh', 'bash', 'fish'];

export const RC_BEGIN = '# >>> otheater profile commands >>>';
export const RC_END = '# <<< otheater profile commands <<<';

/** The shell of `SHELL`, when it is one of those {@link RC_SHELLS} knows. */
export function rcShellOf(env: Env): RcShell | undefined {
  const name = basename(env.SHELL ?? '');
  return (RC_SHELLS as readonly string[]).includes(name) ? (name as RcShell) : undefined;
}

/** The rc file each shell reads when an interactive terminal opens. */
export function rcFileOf(shell: RcShell, env: Env, home: string): string {
  switch (shell) {
    case 'zsh':
      return join(env.ZDOTDIR ?? home, '.zshrc');
    case 'bash':
      return join(home, '.bashrc');
    case 'fish':
      return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'fish', 'config.fish');
  }
}

/** The line that puts `binDir` first in `PATH`. */
export function rcLineOf(shell: RcShell, binDir: string): string {
  return shell === 'fish'
    ? `set -gx PATH ${shQuote(binDir)} $PATH`
    : `export PATH=${shQuote(binDir)}:"$PATH"`;
}

export function rcBlockOf(shell: RcShell, binDir: string): string {
  return `${RC_BEGIN}\n${rcLineOf(shell, binDir)}\n${RC_END}\n`;
}

/** The text without the marked block (and the blank line before it, if this added one). */
export function withoutRcBlock(text: string): string {
  const begin = text.indexOf(RC_BEGIN);
  if (begin === -1) return text;
  const endAt = text.indexOf(RC_END, begin);
  if (endAt === -1) return text;
  let after = endAt + RC_END.length;
  if (text[after] === '\n') after += 1;
  let before = begin;
  if (before >= 2 && text.slice(before - 2, before) === '\n\n') before -= 1;
  return text.slice(0, before) + text.slice(after);
}

/** The text with the block, in place of an old one or at the end. */
export function withRcBlock(text: string, shell: RcShell, binDir: string): string {
  const block = rcBlockOf(shell, binDir);
  const begin = text.indexOf(RC_BEGIN);
  const endAt = begin === -1 ? -1 : text.indexOf(RC_END, begin);
  if (begin !== -1 && endAt !== -1) {
    let after = endAt + RC_END.length;
    if (text[after] === '\n') after += 1;
    return text.slice(0, begin) + block + text.slice(after);
  }
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}`;
}

export type RcChange = 'added' | 'replaced' | 'unchanged' | 'removed' | 'absent';

/** Writes or removes the block in `file`; the rest of the file is kept byte for byte. */
export async function updateRcFile(
  file: string,
  change:
    | { readonly install: true; readonly shell: RcShell; readonly binDir: string }
    | { readonly install: false },
): Promise<RcChange> {
  const before = (await readOrUndefined(file)) ?? '';
  const had = before.includes(RC_BEGIN) && before.includes(RC_END);
  const after = change.install
    ? withRcBlock(before, change.shell, change.binDir)
    : withoutRcBlock(before);
  if (after === before) return change.install ? 'unchanged' : 'absent';
  await mkdir(dirname(file), { recursive: true });
  // Written in place, not renamed over: the file keeps its mode, and a link (a dotfiles manager's)
  // stays a link to the same file.
  await writeFile(file, after, { mode: 0o644 });
  if (!change.install) return 'removed';
  return had ? 'replaced' : 'added';
}
