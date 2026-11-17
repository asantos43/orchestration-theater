// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conflict, NotFound, supportsBranchDelete, supportsDiff } from '@otheater/core';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitVcs, disposeSharedGitIsolations } from './index.js';

let root: string;
let repo: string;
let wt: string;
const vcs = new GitVcs();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-diff-')));
  repo = join(root, 'repo');
  wt = join(root, 'wt');
  await mkdir(repo);
  await mkdir(wt);
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'shared.txt'), 'one\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
});

afterAll(() => {
  disposeSharedGitIsolations();
  disposeTestGitIsolation();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function branchWith(name: string, base: string, file: string, content: string) {
  const path = join(wt, name.replaceAll('/', '-'));
  await vcs.createWorktree({ repo, path, branch: name, base });
  await writeFile(join(path, file), content);
  await vcs.commitAll(path, `change ${file}`);
  await vcs.removeWorktree(path);
}

describe('diffBetween', () => {
  it('is a capability of GitVcs', () => {
    expect(supportsDiff(vcs)).toBe(true);
  });

  it('gives what the head did since it left the base, not what the base did after', async () => {
    await branchWith('work', 'main', 'work.txt', 'from the attempt\n');
    await writeFile(join(repo, 'later.txt'), 'main moved\n');
    await testGit(repo, 'add', '-A');
    await testGit(repo, 'commit', '--quiet', '-m', 'main moves on');
    const diff = await vcs.diffBetween(repo, 'main', 'work');
    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain('+from the attempt');
    expect(diff.text).not.toContain('main moved');
  });

  it('clips a long diff and says so', async () => {
    await branchWith('big', 'main', 'big.txt', `${'x'.repeat(500)}\n`);
    const diff = await vcs.diffBetween(repo, 'main', 'big', 100);
    expect(diff.truncated).toBe(true);
    expect(diff.text).toHaveLength(100);
  });

  it('rejects a ref that is not there', async () => {
    await expect(vcs.diffBetween(repo, 'main', 'nope')).rejects.toBeInstanceOf(NotFound);
  });
});

describe('deleteBranch', () => {
  it('is a capability of GitVcs', () => {
    expect(supportsBranchDelete(vcs)).toBe(true);
  });

  it('deletes a branch, and a branch that is not there is a no-op', async () => {
    await branchWith('gone', 'main', 'gone.txt', 'x\n');
    await vcs.deleteBranch(repo, 'gone');
    await expect(vcs.resolveRef(repo, 'gone')).rejects.toBeInstanceOf(NotFound);
    await expect(vcs.deleteBranch(repo, 'gone')).resolves.toBeUndefined();
  });

  it('refuses a branch that is checked out in a worktree', async () => {
    const path = join(wt, 'live');
    await vcs.createWorktree({ repo, path, branch: 'live', base: 'main' });
    await expect(vcs.deleteBranch(repo, 'live')).rejects.toBeInstanceOf(Conflict);
    await vcs.removeWorktree(path);
  });
});
