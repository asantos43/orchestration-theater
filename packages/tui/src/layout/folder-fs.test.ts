// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFolderFs } from './folder-fs.js';

/** The disk behind the browser (N332), on temporary folders: no real home, no real repository. */

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) {
    await chmod(folder, 0o755).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
});

async function temp(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'otheater-n332-fs-')));
  made.push(folder);
  return folder;
}

describe('nodeFolderFs', () => {
  it('lists the subfolders, a link to a folder included, and no files', async () => {
    const root = await temp();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'file.txt'), 'x');
    await mkdir(join(root, 'target'));
    const fs = nodeFolderFs(root);
    expect(fs.home).toBe(root);
    const listing = fs.list(root);
    expect(listing.ok && [...listing.names].sort()).toEqual(['.hidden', 'a', 'target']);
    if (process.platform !== 'win32') {
      await symlink(join(root, 'target'), join(root, 'link'));
      await symlink(join(root, 'file.txt'), join(root, 'filelink'));
      await symlink(join(root, 'nowhere'), join(root, 'broken'));
      const again = fs.list(root);
      expect(again.ok && [...again.names].sort()).toEqual(['.hidden', 'a', 'link', 'target']);
    }
  });

  it('says whether a path is a folder', async () => {
    const root = await temp();
    await writeFile(join(root, 'file.txt'), 'x');
    const fs = nodeFolderFs(root);
    expect(fs.isDirectory(root)).toBe(true);
    expect(fs.isDirectory(join(root, 'file.txt'))).toBe(false);
    expect(fs.isDirectory(join(root, 'nope'))).toBe(false);
  });

  it('answers the error code of a folder that does not exist or cannot be read', async () => {
    const root = await temp();
    const fs = nodeFolderFs(root);
    expect(fs.list(join(root, 'nope'))).toEqual({ ok: false, code: 'ENOENT' });
    // Root can read anything, and Windows has no such mode: only where a mode of 0 keeps the reader out.
    const denied = join(root, 'denied');
    await mkdir(denied);
    await chmod(denied, 0o000);
    const result = fs.list(denied);
    if (!result.ok) expect(result.code).toBe('EACCES');
    await chmod(denied, 0o755);
  });

  it('reads the branch of a repository, a detached HEAD and a folder with no .git', async () => {
    const root = await temp();
    const fs = nodeFolderFs(root);
    expect(fs.git(root)).toBeUndefined();

    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(fs.git(repo)).toEqual({ ref: 'main', detached: false, worktree: false });

    const detached = join(root, 'detached');
    await mkdir(join(detached, '.git'), { recursive: true });
    await writeFile(join(detached, '.git', 'HEAD'), `${'0123456789abcdef'.repeat(2)}01234567\n`);
    expect(fs.git(detached)).toEqual({ ref: '0123456', detached: true, worktree: false });

    const empty = join(root, 'empty');
    await mkdir(join(empty, '.git'), { recursive: true });
    expect(fs.git(empty)).toEqual({ ref: '', detached: false, worktree: false });
  });

  it('follows the .git file of a worktree to its own HEAD', async () => {
    const root = await temp();
    const fs = nodeFolderFs(root);
    const admin = join(root, 'main', '.git', 'worktrees', 'feature');
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'HEAD'), 'ref: refs/heads/feature\n');
    const worktree = join(root, 'feature');
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), `gitdir: ${admin}\n`);
    expect(fs.git(worktree)).toEqual({ ref: 'feature', detached: false, worktree: true });

    // A relative target is read from the folder of the worktree.
    const relative = join(root, 'relative');
    await mkdir(relative);
    await writeFile(join(relative, '.git'), 'gitdir: ../main/.git/worktrees/feature\n');
    expect(fs.git(relative)).toEqual({ ref: 'feature', detached: false, worktree: true });

    // A .git file that points nowhere is a repository whose HEAD cannot be read, not a crash.
    const broken = join(root, 'broken');
    await mkdir(broken);
    await writeFile(join(broken, '.git'), 'gitdir: ../gone\n');
    expect(fs.git(broken)).toEqual({ ref: '', detached: false, worktree: true });
    const garbage = join(root, 'garbage');
    await mkdir(garbage);
    await writeFile(join(garbage, '.git'), 'no pointer\n');
    expect(fs.git(garbage)).toEqual({ ref: '', detached: false, worktree: true });
  });

  it('has drives only on Windows', () => {
    const fs = nodeFolderFs('/x');
    expect(fs.drives === undefined).toBe(process.platform !== 'win32');
  });
});
