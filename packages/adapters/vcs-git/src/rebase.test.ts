// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conflict, supportsRebase } from '@otheater/core';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitVcs, disposeSharedGitIsolations } from './index.js';

let root: string;
let repo: string;
let wt: string;
const vcs = new GitVcs();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-rebase-')));
  repo = join(root, 'repo');
  wt = join(root, 'wt');
  await mkdir(repo);
  await mkdir(wt);
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'shared.txt'), 'one\ntwo\nthree\n');
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

/** A branch off `base` with `file` written and committed; the worktree goes away. */
async function branchWith(
  name: string,
  base: string,
  file: string,
  content: string,
): Promise<void> {
  const path = join(wt, name.replaceAll('/', '-'));
  await vcs.createWorktree({ repo, path, branch: name, base });
  await writeFile(join(path, file), content);
  await vcs.commitAll(path, `change ${file} on ${name}`);
  await vcs.removeWorktree(path);
}

describe('rebaseBranch', () => {
  it('is a capability of GitVcs', () => {
    expect(supportsRebase(vcs)).toBe(true);
  });

  it('replays the commits after the old upstream onto the new one, in place', async () => {
    await branchWith('dep-1', 'main', 'dep.txt', 'first\n');
    await branchWith('child', 'dep-1', 'child.txt', 'child\n');
    await branchWith('dep-2', 'main', 'dep.txt', 'second\n');
    const before = await testGit(repo, 'rev-parse', 'child');

    const outcome = await vcs.rebaseBranch(repo, 'child', 'dep-2', { upstream: 'dep-1' });
    // dep.txt differs between dep-1 and dep-2, but the child never touched it: no conflict.
    expect(outcome).toMatchObject({ kind: 'rebased' });
    const after = await testGit(repo, 'rev-parse', 'child');
    expect(after).not.toBe(before);
    await testGit(repo, 'merge-base', '--is-ancestor', 'dep-2', 'child');
    expect(await testGit(repo, 'show', 'child:dep.txt')).toBe('second');
    expect(await testGit(repo, 'show', 'child:child.txt')).toBe('child');
    // The throwaway worktree is gone and no worktree holds the branch.
    expect((await vcs.listWorktrees(repo)).map((entry) => entry.branch)).toEqual(['main']);
  });

  it('reports the conflicting files and leaves the branch where it was', async () => {
    await branchWith('dep-1', 'main', 'dep.txt', 'first\n');
    await branchWith('child', 'dep-1', 'dep.txt', 'child edit\n');
    await branchWith('dep-2', 'main', 'dep.txt', 'second\n');
    const before = await testGit(repo, 'rev-parse', 'child');

    const outcome = await vcs.rebaseBranch(repo, 'child', 'dep-2', { upstream: 'dep-1' });
    expect(outcome).toEqual({ kind: 'conflict', files: ['dep.txt'] });
    expect(await testGit(repo, 'rev-parse', 'child')).toBe(before);
    expect((await vcs.listWorktrees(repo)).map((entry) => entry.branch)).toEqual(['main']);
  });

  it('is up to date when the branch already sits on the target', async () => {
    await branchWith('child', 'main', 'child.txt', 'child\n');
    const head = await testGit(repo, 'rev-parse', 'child');
    expect(await vcs.rebaseBranch(repo, 'child', 'main')).toEqual({
      kind: 'up_to_date',
      sha: head,
    });
  });

  it('without an upstream, replays what the branch has over a target that moved', async () => {
    await branchWith('child', 'main', 'child.txt', 'child\n');
    await writeFile(join(repo, 'other.txt'), 'other\n');
    await testGit(repo, 'add', '-A');
    await testGit(repo, 'commit', '--quiet', '-m', 'main moves on');
    const outcome = await vcs.rebaseBranch(repo, 'child', 'main');
    expect(outcome.kind).toBe('rebased');
    expect(await testGit(repo, 'show', 'child:other.txt')).toBe('other');
    expect(await readFile(join(repo, 'other.txt'), 'utf8')).toBe('other\n');
  });

  it('refuses a branch that is checked out in a worktree', async () => {
    const path = join(wt, 'held');
    await vcs.createWorktree({ repo, path, branch: 'held', base: 'main' });
    await expect(vcs.rebaseBranch(repo, 'held', 'main')).rejects.toBeInstanceOf(Conflict);
  });
});
