// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterUnavailable, InvalidInput, type Vcs } from '@otheater/core';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import { inspectFolder } from './inspect.js';

afterAll(disposeTestGitIsolation);

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-inspect-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('inspectFolder (N332)', () => {
  it('missing: the path does not exist', async () => {
    const path = join(root, 'nothing');
    expect(await inspectFolder(defaultVcs(), path)).toEqual({ path, state: 'missing', git: null });
  });

  it('empty: a folder with nothing in it', async () => {
    const path = join(root, 'empty');
    await mkdir(path);
    expect(await inspectFolder(defaultVcs(), path)).toEqual({ path, state: 'empty', git: null });
  });

  it('files: a folder with files and no git', async () => {
    const path = join(root, 'files');
    await mkdir(path);
    await writeFile(join(path, 'a.txt'), 'a\n');
    expect(await inspectFolder(defaultVcs(), path)).toEqual({ path, state: 'files', git: null });
  });

  it('repo: the root of a repository, with its branch', async () => {
    const path = join(root, 'repo');
    await mkdir(path);
    await testGit(path, 'init', '--quiet', '--initial-branch=trunk');
    expect(await inspectFolder(defaultVcs(), path)).toEqual({
      path,
      state: 'repo',
      git: { root: path, branch: 'trunk' },
    });
  });

  it('inside_repo: a subfolder of a repository', async () => {
    const repo = join(root, 'repo');
    const path = join(repo, 'src', 'deep');
    await mkdir(path, { recursive: true });
    await testGit(repo, 'init', '--quiet', '--initial-branch=main');
    expect(await inspectFolder(defaultVcs(), path)).toEqual({
      path,
      state: 'inside_repo',
      git: { root: repo, branch: 'main' },
    });
  });

  it('a path that is a file is invalid, and so is one below a file', async () => {
    const file = join(root, 'file.txt');
    await writeFile(file, 'x\n');
    await expect(inspectFolder(defaultVcs(), file)).rejects.toBeInstanceOf(InvalidInput);
    await expect(inspectFolder(defaultVcs(), join(file, 'below'))).rejects.toBeInstanceOf(
      InvalidInput,
    );
  });

  it('a Vcs that cannot locate is unavailable', async () => {
    await expect(inspectFolder({} as Vcs, root)).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});
