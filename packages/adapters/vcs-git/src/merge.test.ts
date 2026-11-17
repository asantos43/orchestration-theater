// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDEMPOTENCY_TRAILER,
  supportsHistory,
  supportsMerge,
  withIdempotencyTrailer,
} from '@otheater/core';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitVcs, disposeSharedGitIsolations } from './index.js';

let root: string;
let repo: string;
let wt: string;
const vcs = new GitVcs();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-merge-')));
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

/** A worktree on a new branch of main with `file` written and committed. */
async function branchWith(name: string, file: string, content: string): Promise<string> {
  const path = join(wt, name);
  await vcs.createWorktree({ repo, path, branch: name, base: 'main' });
  await writeFile(join(path, file), content);
  await vcs.commitAll(path, `change ${file} on ${name}`);
  return path;
}

describe('capability guards', () => {
  it('GitVcs is a VcsMerge and a VcsHistory', () => {
    expect(supportsMerge(vcs)).toBe(true);
    expect(supportsHistory(vcs)).toBe(true);
  });
});

describe('merge', () => {
  it('merges a branch with a merge commit and brings its files', async () => {
    await branchWith('a', 'a.txt', 'from a\n');
    const target = join(wt, 'target');
    await vcs.createWorktree({ repo, path: target, branch: 'target', base: 'main' });
    const outcome = await vcs.merge(target, 'a', { message: 'integrate: a' });
    expect(outcome.kind).toBe('merged');
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('from a\n');
    expect(outcome.kind === 'merged' ? outcome.sha : '').toBe(await vcs.headOf(target));
    // `--no-ff`: even when a fast-forward was possible, the history keeps a merge commit.
    const parents = await testGit(target, 'rev-list', '--parents', '-n', '1', 'HEAD');
    expect(parents.split(' ')).toHaveLength(3);
    expect(await testGit(target, 'log', '-1', '--format=%s')).toBe('integrate: a');
  });

  it('merges two branches that touch different files, one after the other', async () => {
    await branchWith('a', 'a.txt', 'from a\n');
    await branchWith('b', 'b.txt', 'from b\n');
    const target = join(wt, 'target');
    await vcs.createWorktree({ repo, path: target, branch: 'target', base: 'main' });
    expect((await vcs.merge(target, 'a')).kind).toBe('merged');
    expect((await vcs.merge(target, 'b')).kind).toBe('merged');
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('from a\n');
    expect(await readFile(join(target, 'b.txt'), 'utf8')).toBe('from b\n');
  });

  it('answers up_to_date for what is already part of the branch', async () => {
    await branchWith('a', 'a.txt', 'from a\n');
    const target = join(wt, 'target');
    await vcs.createWorktree({ repo, path: target, branch: 'target', base: 'main' });
    await vcs.merge(target, 'a');
    const head = await vcs.headOf(target);
    expect(await vcs.merge(target, 'a')).toEqual({ kind: 'up_to_date', sha: head });
    expect(await vcs.merge(target, 'main')).toEqual({ kind: 'up_to_date', sha: head });
  });

  it('a conflict is an outcome, lists the files and leaves the worktree clean', async () => {
    await branchWith('a', 'shared.txt', 'one\nTWO FROM A\nthree\n');
    await branchWith('b', 'shared.txt', 'one\nTWO FROM B\nthree\n');
    const target = join(wt, 'target');
    await vcs.createWorktree({ repo, path: target, branch: 'target', base: 'main' });
    await vcs.merge(target, 'a');
    const before = await vcs.headOf(target);
    const outcome = await vcs.merge(target, 'b');
    expect(outcome).toEqual({ kind: 'conflict', files: ['shared.txt'] });
    expect(await vcs.headOf(target)).toBe(before);
    expect(await testGit(target, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(target, 'shared.txt'), 'utf8')).toBe('one\nTWO FROM A\nthree\n');
    // After the abort the worktree can merge something else.
    await branchWith('c', 'c.txt', 'from c\n');
    expect((await vcs.merge(target, 'c')).kind).toBe('merged');
  });

  it('rejects with Conflict on uncommitted changes and NotFound for a missing ref', async () => {
    await branchWith('a', 'a.txt', 'from a\n');
    const target = join(wt, 'target');
    await vcs.createWorktree({ repo, path: target, branch: 'target', base: 'main' });
    expect(await rejection(vcs.merge(target, 'no-such-branch'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    await writeFile(join(target, 'dirty.txt'), 'x\n');
    expect(await rejection(vcs.merge(target, 'a'))).toMatchObject({ code: 'CONFLICT' });
    expect(await rejection(vcs.merge(target, '--abort'))).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('history queries', () => {
  it('resolveRef gives the sha of a branch and NotFound for a missing one', async () => {
    const sha = await testGit(repo, 'rev-parse', 'main');
    expect(await vcs.resolveRef(repo, 'main')).toBe(sha);
    expect(await rejection(vcs.resolveRef(repo, 'nope'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('findCommitByTrailer finds the commit that carries the key, and only that one', async () => {
    const path = join(wt, 'work');
    await vcs.createWorktree({ repo, path, branch: 'work', base: 'main' });
    await writeFile(join(path, 'one.txt'), '1\n');
    const withKey = await vcs.commitAll(
      path,
      withIdempotencyTrailer('add one', 'attempt-1:commit'),
    );
    await writeFile(join(path, 'two.txt'), '2\n');
    await vcs.commitAll(path, withIdempotencyTrailer('add two', 'attempt-1:other'));
    await writeFile(join(path, 'three.txt'), '3\n');
    await vcs.commitAll(path, 'a commit that mentions attempt-1:commit in its body only');

    expect(
      await vcs.findCommitByTrailer(repo, 'work', IDEMPOTENCY_TRAILER, 'attempt-1:commit'),
    ).toBe(withKey);
    expect(
      await vcs.findCommitByTrailer(repo, 'work', IDEMPOTENCY_TRAILER, 'attempt-1:missing'),
    ).toBeUndefined();
    // The trailer is on `work`, not on `main`.
    expect(
      await vcs.findCommitByTrailer(repo, 'main', IDEMPOTENCY_TRAILER, 'attempt-1:commit'),
    ).toBeUndefined();
  });

  it('findCommitByTrailer rejects a missing ref and a bad key', async () => {
    expect(
      await rejection(vcs.findCommitByTrailer(repo, 'nope', IDEMPOTENCY_TRAILER, 'k')),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(vcs.findCommitByTrailer(repo, 'main', 'bad key', 'k'))).toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
