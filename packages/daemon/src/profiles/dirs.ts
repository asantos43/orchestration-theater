// SPDX-License-Identifier: MPL-2.0
import { lstat, mkdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Conflict, InvalidInput } from '@otheater/core';
import { profileDirOf, type DataPaths, type ProfileNames } from '../paths.js';

/** What happened to the directory of a profile that was removed. */
export type DirRemoval = 'deleted' | 'backup' | 'missing';

/** Where `keep_backup` moves a removed profile (a dot-name, so no client can be called that). */
export const REMOVED_DIR_NAME = '.removed';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Creates the isolated directory of a profile (mode 0700) and returns whether this call made it.
 * An existing directory is adopted (the user may have logged in there by hand) and left as it is;
 * a symlink or a file in its place is refused: the daemon never writes through a link.
 */
export async function createProfileDir(
  paths: Pick<DataPaths, 'profiles'>,
  names: ProfileNames,
): Promise<{ readonly dir: string; readonly created: boolean }> {
  const dir = profileDirOf(paths, names);
  try {
    const found = await lstat(dir);
    if (!found.isDirectory()) {
      throw new Conflict(`The profile path exists and is not a directory: ${dir}`);
    }
    return { dir, created: false };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { dir, created: true };
}

export interface RemoveDirOptions {
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly names: ProfileNames;
  /** The `dir` the registry holds; it must be exactly the one the names give. */
  readonly recorded: string;
  readonly mode: 'delete' | 'keep_backup';
  /** Part of the backup name, so two removals never collide. */
  readonly stamp: number;
}

/**
 * Takes the directory of a profile away, and only that. The path is recomputed from the names and
 * must equal the recorded one (a row edited to point elsewhere deletes nothing); a link is
 * unlinked, never followed; what is left must still be inside `<data>/profiles` once its links are
 * resolved. A missing directory is not an error (a retry after a partial failure).
 * `keep_backup` moves it to `<data>/profiles/.removed/` instead of deleting it.
 */
export async function removeProfileDir(options: RemoveDirOptions): Promise<DirRemoval> {
  const expected = profileDirOf(options.paths, options.names);
  if (resolve(options.recorded) !== expected) {
    throw new InvalidInput(
      'The recorded profile directory is not the one its names give; nothing was removed',
    );
  }
  let found;
  try {
    found = await lstat(expected);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  if (found.isSymbolicLink()) {
    await unlink(expected);
    return 'deleted';
  }
  if (!found.isDirectory()) {
    throw new Conflict(`The profile path is not a directory; nothing was removed: ${expected}`);
  }
  const root = await realpath(resolve(options.paths.profiles));
  const real = await realpath(expected);
  if (!real.startsWith(`${root}${sep}`)) {
    throw new InvalidInput('The profile directory resolves outside the profiles root; kept');
  }
  if (options.mode === 'keep_backup') {
    const backups = resolve(options.paths.profiles, REMOVED_DIR_NAME);
    await mkdir(backups, { recursive: true, mode: 0o700 });
    await rename(
      real,
      resolve(backups, `${options.names.client}-${options.names.profile}-${String(options.stamp)}`),
    );
    return 'backup';
  }
  await rm(real, { recursive: true, force: true });
  return 'deleted';
}
