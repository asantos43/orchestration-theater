// SPDX-License-Identifier: MPL-2.0
import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AdapterUnavailable, InvalidInput, supportsLocate, type Vcs } from '@otheater/core';
import type { FolderState } from '@otheater/protocol';

/** What {@link inspectFolder} found out about a folder (N332). [proposta] */
export interface FolderInspection {
  /** The absolute path asked, normalized (symlinks are not resolved, so the Producer recognizes it). */
  readonly path: string;
  readonly state: FolderState;
  /** The repository the folder is the root of, or is inside of. */
  readonly git: { readonly root: string; readonly branch: string | null } | null;
}

/**
 * Tells what a folder is, changing nothing: `missing`, `empty`, `files` (files and no git),
 * `repo` (the root of a repository) or `inside_repo` (a subfolder of one). A path that is a file is
 * `InvalidInput`. The repository comes from the `Vcs` (`VcsLocate`); a `Vcs` without it is
 * `AdapterUnavailable`, because telling a plain folder from a repository by looking for `.git` here
 * would be a second git client (and would miss a worktree, a `gitdir:` file and a parent repository).
 */
export async function inspectFolder(vcs: Vcs, folder: string): Promise<FolderInspection> {
  if (!supportsLocate(vcs)) {
    throw new AdapterUnavailable('This Vcs adapter cannot tell where a folder sits in git');
  }
  const path = resolve(folder);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { path, state: 'missing', git: null };
    if (code === 'ENOTDIR') {
      throw new InvalidInput(`"${path}" is inside something that is not a folder`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new InvalidInput(`"${path}" is a file, not a folder`);
  const located = await vcs.locate(path);
  if (located !== undefined) {
    const real = await realpath(path).catch(() => path);
    return {
      path,
      state: located.root === real ? 'repo' : 'inside_repo',
      git: { root: located.root, branch: located.branch ?? null },
    };
  }
  const entries = await readdir(path);
  return { path, state: entries.length === 0 ? 'empty' : 'files', git: null };
}
