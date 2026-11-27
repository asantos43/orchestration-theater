// SPDX-License-Identifier: MPL-2.0
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseGitdirFile,
  parseGitHead,
  type FolderFs,
  type FolderListing,
  type GitMark,
} from './folder-picker.js';

/**
 * The disk behind the folder browser (N332): the TUI runs on the machine of the daemon, so it
 * reads the folders itself, as the prompt already does with `existsSync`. Nothing here throws: a
 * folder that cannot be read comes back as its error code.
 */

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function list(dir: string): FolderListing {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: typeof code === 'string' ? code : 'EIO' };
  }
  const names: string[] = [];
  for (const item of items) {
    if (item.isDirectory()) names.push(item.name);
    // A link to a folder is a folder to walk into; a broken one, or a link to a file, is not.
    else if (item.isSymbolicLink() && isDirectory(join(dir, item.name))) names.push(item.name);
  }
  return { ok: true, names };
}

/** The Git mark of `dir`: its `.git` is a folder (HEAD inside) or a file that points to one (a worktree). */
function git(dir: string): GitMark | undefined {
  const dotGit = join(dir, '.git');
  let info;
  try {
    info = statSync(dotGit);
  } catch {
    return undefined;
  }
  let gitDir = dotGit;
  const worktree = !info.isDirectory();
  if (worktree) {
    try {
      const target = parseGitdirFile(readFileSync(dotGit, 'utf8'));
      if (target === undefined) return { ref: '', detached: false, worktree };
      gitDir = resolve(dir, target);
    } catch {
      return { ref: '', detached: false, worktree };
    }
  }
  try {
    return { ...parseGitHead(readFileSync(join(gitDir, 'HEAD'), 'utf8')), worktree };
  } catch {
    return { ref: '', detached: false, worktree };
  }
}

/** Windows: the drives that exist, from `A:\` to `Z:\`. */
function drives(): readonly string[] {
  const found: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (isDirectory(root)) found.push(root);
  }
  return found;
}

/** The folder browser on the real disk; `home` is the home folder of the person. */
export function nodeFolderFs(home: string = homedir()): FolderFs {
  return {
    home,
    isDirectory,
    list,
    git,
    ...(process.platform === 'win32' ? { drives } : {}),
  };
}
