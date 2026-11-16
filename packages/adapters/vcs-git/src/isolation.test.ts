// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from './git.js';
import {
  createGitIsolation,
  disposeSharedGitIsolations,
  removeGitIsolation,
  sharedGitIsolation,
} from './isolation.js';

let parent: string;

beforeEach(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'otheater-isolation-test-')));
});

afterAll(disposeSharedGitIsolations);

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe('the isolation directory', () => {
  it('holds an empty config file and two empty folders, none of them writable', async () => {
    const isolation = createGitIsolation(parent);
    expect(isolation.root.startsWith(parent)).toBe(true);
    expect(await readFile(isolation.configFile, 'utf8')).toBe('');
    expect(await readdir(isolation.homeDir)).toEqual([]);
    expect(await readdir(isolation.hooksDir)).toEqual([]);
    if (process.platform !== 'win32') {
      // POSIX mode bits; Windows keeps only a read-only attribute on files.
      expect((await stat(isolation.configFile)).mode & 0o222).toBe(0);
      expect((await stat(isolation.homeDir)).mode & 0o222).toBe(0);
      expect((await stat(isolation.hooksDir)).mode & 0o222).toBe(0);
    }
    removeGitIsolation(isolation);
    await expect(stat(isolation.root)).rejects.toThrow();
  });

  it('is shared per parent directory and built on first use', async () => {
    const one = sharedGitIsolation(parent);
    expect(sharedGitIsolation(parent)).toBe(one);
    expect(await readdir(parent)).toEqual([one.root.slice(parent.length + 1)]);
    const other = join(parent, 'other');
    expect(sharedGitIsolation(other).root.startsWith(other)).toBe(true);
  });

  it('fails AdapterUnavailable when the folder cannot be created', async () => {
    const file = join(parent, 'a-file');
    await writeFile(file, '');
    expect(() => createGitIsolation(join(file, 'below'))).toThrow(
      expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error,
    );
  });

  it('a runner uses the injected isolation root', async () => {
    const root = join(parent, 'data');
    await mkdir(root);
    const repo = join(parent, 'repo');
    await mkdir(repo);
    const runner = new GitRunner({ isolationRoot: root });
    await runner.run(repo, ['init', '--quiet', '--initial-branch=main']);
    expect((await readdir(root)).filter((name) => name.startsWith('otheater-git-'))).toHaveLength(
      1,
    );
  });
});
