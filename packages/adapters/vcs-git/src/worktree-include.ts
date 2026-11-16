// SPDX-License-Identifier: MPL-2.0
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';
import type { GitRunner } from './git.js';

/** Name of the file at the repository root that lists the untracked files to carry over. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** A file the copy left out, and why. A skip never fails the creation of the worktree. */
export interface WorktreeIncludeSkip {
  /** Path relative to the repository root, with `/` separators. */
  readonly path: string;
  readonly reason: string;
}

export interface WorktreeIncludeResult {
  /** Paths copied, relative to the repository root. */
  readonly copied: readonly string[];
  readonly skipped: readonly WorktreeIncludeSkip[];
}

const NOTHING: WorktreeIncludeResult = { copied: [], skipped: [] };

/**
 * Copies from `source` (the main worktree) into `target` (a new worktree) the files that
 * `<source>/.worktreeinclude` selects (architecture 5.5).
 *
 * Selection rule, taken from ccmanager (MIT; `docs/worktree-include.md`, read 2026-11-16): a file
 * is copied only when it matches a pattern of `.worktreeinclude` (gitignore syntax: `#` comments,
 * `!` negation, a leading `/`, `**`, a directory selects what is inside it) **and** git ignores it
 * (`.gitignore`, `.git/info/exclude`). So a tracked file is never copied, and neither is an
 * untracked file that git does not ignore. Git itself evaluates both rules, so the matching is
 * exactly git's own and there is no second matcher to drift from it.
 *
 * Guards: a symbolic link is never copied nor followed (neither the file nor a directory on its
 * path), nothing under `.git` is copied, and a file that already exists at the destination is
 * kept. Only the copy is done; ccmanager's post-creation hooks are left for later.
 */
export async function copyWorktreeInclude(
  git: GitRunner,
  source: string,
  target: string,
): Promise<WorktreeIncludeResult> {
  const includeFile = join(source, WORKTREE_INCLUDE_FILE);
  try {
    const info = await lstat(includeFile);
    // A link could make git read a file outside the repository as a pattern list.
    if (!info.isFile()) return NOTHING;
  } catch {
    return NOTHING;
  }

  const matched = await git.run(source, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    `--exclude-from=${WORKTREE_INCLUDE_FILE}`,
  ]);
  const candidates = splitNul(matched);
  if (candidates.length === 0) return NOTHING;

  // Of those, keep what git also ignores. Exit code 1 means "none of them".
  const ignored = await git.try(source, ['check-ignore', '-z', '--stdin'], {
    input: candidates.map((path) => `${path}\0`).join(''),
  });
  if (ignored.code > 1) {
    // Surface the git error instead of copying nothing in silence.
    throw new AdapterUnavailable(`git check-ignore failed: ${ignored.stderr.trim()}`);
  }
  const selected = new Set(splitNul(ignored.stdout));

  const realSource = await realpath(source);
  const realTarget = await realpath(target);
  const copied: string[] = [];
  const skipped: WorktreeIncludeSkip[] = [];
  for (const path of candidates) {
    if (!selected.has(path)) continue;
    const reason = await copyOne(realSource, realTarget, path);
    if (reason === undefined) copied.push(path);
    else skipped.push({ path, reason });
  }
  return { copied, skipped };
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Copies one file; returns why it was skipped, or `undefined` when it was copied. */
async function copyOne(
  realSource: string,
  realTarget: string,
  path: string,
): Promise<string | undefined> {
  const parts = path.split('/');
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git')
  ) {
    return 'unsafe path';
  }
  const from = join(realSource, ...parts);
  try {
    const info = await lstat(from);
    if (info.isSymbolicLink()) return 'symbolic link';
    if (!info.isFile()) return 'not a regular file';
    // A directory of the path may be a link that leaves the repository.
    const realParent = await realpath(dirname(from));
    if (realParent !== realSource && !realParent.startsWith(realSource + sep)) {
      return 'outside the repository';
    }
    const directory = await ensureDirectoryInside(realTarget, parts.slice(0, -1));
    if (directory === undefined) return 'destination path crosses a link or a file';
    await copyFile(from, join(directory, parts[parts.length - 1] ?? ''), constants.COPYFILE_EXCL);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'already exists';
    return `copy failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Creates the directories of `parts` below `root` one at a time, refusing to go through a
 * symbolic link or a file. Returns the final directory, or `undefined` when one was refused.
 */
async function ensureDirectoryInside(
  root: string,
  parts: readonly string[],
): Promise<string | undefined> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  return current;
}
