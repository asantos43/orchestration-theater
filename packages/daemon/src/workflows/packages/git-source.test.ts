// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import { execRunner } from '../../plugins/sources.js';
import { fetchPackageFromGit } from './git-source.js';
import {
  fileUrl,
  gitCommitAll,
  gitInit,
  gitTag,
  removeTempFolders,
  tempFolder,
} from './packages.test-support.js';

afterEach(removeTempFolders);

async function context(): Promise<{
  runner: typeof execRunner;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stage: string;
}> {
  return {
    runner: execRunner,
    env: { PATH: process.env.PATH },
    timeoutMs: 30_000,
    stage: await tempFolder(),
  };
}

async function repo(): Promise<{ root: string; first: string }> {
  const root = await tempFolder();
  await gitInit(root);
  await writeFile(join(root, 'note.txt'), 'one\n');
  const first = await gitCommitAll(root, 'one');
  return { root, first };
}

describe('fetchPackageFromGit', () => {
  it('resolves the default branch to a commit and drops .git', async () => {
    const { root, first } = await repo();
    const fetched = await fetchPackageFromGit(
      { url: fileUrl(root), ref: undefined },
      await context(),
    );
    expect(fetched.origin).toEqual({ kind: 'git', url: fileUrl(root), ref: 'HEAD', commit: first });
    expect(await readFile(join(fetched.root, 'note.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(fetched.root, '.git'))).toBe(false);
  });

  it('pins a branch and a tag to the commit they point to now', async () => {
    const { root, first } = await repo();
    await gitTag(root, 'v1');
    await writeFile(join(root, 'note.txt'), 'two\n');
    const second = await gitCommitAll(root, 'two');
    const byTag = await fetchPackageFromGit({ url: fileUrl(root), ref: 'v1' }, await context());
    expect(byTag.origin).toMatchObject({ ref: 'v1', commit: first });
    expect(await readFile(join(byTag.root, 'note.txt'), 'utf8')).toBe('one\n');
    const byBranch = await fetchPackageFromGit(
      { url: fileUrl(root), ref: 'main' },
      await context(),
    );
    expect(byBranch.origin).toMatchObject({ ref: 'main', commit: second });
  });

  it('takes a full commit as the ref, and refuses one that is not in the repository', async () => {
    const { root, first } = await repo();
    const exact = await fetchPackageFromGit({ url: fileUrl(root), ref: first }, await context());
    expect(exact.origin.commit).toBe(first);
    await expect(
      fetchPackageFromGit({ url: fileUrl(root), ref: 'a'.repeat(40) }, await context()),
    ).rejects.toThrow(InvalidInput);
    await expect(
      fetchPackageFromGit({ url: fileUrl(root), ref: 'no-such-branch' }, await context()),
    ).rejects.toThrow(/no "no-such-branch"/);
  });

  it('refuses a URL git must not use', async () => {
    await expect(
      fetchPackageFromGit({ url: 'ext::sh -c id', ref: undefined }, await context()),
    ).rejects.toThrow(InvalidInput);
    await expect(
      fetchPackageFromGit({ url: 'http://example.invalid/a.git', ref: undefined }, await context()),
    ).rejects.toThrow(/not accepted/);
  });
});
