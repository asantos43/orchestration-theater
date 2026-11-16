// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  attemptBranch,
  integrationBranch,
  isCheckpointMessage,
  isOTheaterError,
  playBranch,
  VCS_PORT_VERSION,
  checkpointMessage,
  type Vcs,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface VcsHarness extends Disposable {
  readonly vcs: Vcs;
}

/** Ceiling of each test; the suite runs many real `git` commands. */
const TEST_TIMEOUT_MS = 30_000;

/**
 * Runs `git` for a test fixture, with the same isolation the adapter must have: no system or
 * global config, no hooks, no prompts, no signing, a fixed identity, messages in English.
 * Returns stdout without the final newline. Exported for the tests of the adapters.
 */
export function testGit(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Conformance',
        '-c',
        'user.email=conformance@localhost',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: process.env.PATH ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_TERMINAL_PROMPT: '0',
          HOME: devNull,
          XDG_CONFIG_HOME: devNull,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
        else resolve(stdout.replace(/\n$/, ''));
      },
    );
  });
}

interface Sandbox {
  /** Real path of the temporary root: holds `repo`, `wt` and `outside`, and nothing else. */
  readonly root: string;
  /** The repository under test, with one commit on `main`. */
  readonly repo: string;
  /** Folder where the tests put worktrees. */
  readonly wt: string;
  /** Folder next to the repository with a file that no operation may touch. */
  readonly outside: string;
}

const INITIAL_FILES: Readonly<Record<string, string>> = {
  'README.md': 'hello\n',
  'src/app.txt': 'one\ntwo\nthree\n',
  '.gitignore': '.env\nsecret/\n*.log\nleak.txt\nlinkdir\nnotes.txt.ignored\n',
  '.worktreeinclude': '# local files\n.env\nsecret/\nleak.txt\nlinkdir\nnotes.txt\n',
};

const OUTSIDE_FILE = 'secret.txt';
const OUTSIDE_CONTENT = 'must never be copied\n';

async function createSandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-conf-')));
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(repo), mkdir(wt), mkdir(outside)]);
  await writeFile(join(outside, OUTSIDE_FILE), OUTSIDE_CONTENT);
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  for (const [path, content] of Object.entries(INITIAL_FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
  return { root, repo, wt, outside };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Registers the `Vcs` conformance tests (port version {@link VCS_PORT_VERSION}) in the calling
 * Vitest file. The suite builds its own temporary repository (one commit on `main`, a
 * `.gitignore` and a `.worktreeinclude`) and removes it after each test; the factory only builds
 * the adapter. Needs a `git` on the `PATH` (architecture 5.5).
 */
export function describeVcsConformance(name: string, factory: AdapterFactory<VcsHarness>): void {
  describe(
    `Vcs conformance: ${name} (port ${VCS_PORT_VERSION})`,
    { timeout: TEST_TIMEOUT_MS },
    () => {
      const harness = useHarness(factory);
      let box: Sandbox;
      beforeEach(async () => {
        box = await createSandbox();
      });
      afterEach(async () => {
        await rm(box.root, { recursive: true, force: true });
      });

      const vcs = (): Vcs => harness().vcs;

      /** Creates a worktree of `branch` under `wt/<dir>` from `main`. */
      async function open(dir: string, branch: string, base = 'main'): Promise<string> {
        const path = join(box.wt, dir);
        await vcs().createWorktree({ repo: box.repo, path, branch, base });
        return path;
      }

      it('declares the Vcs port and a range that covers this version', () => {
        expect(vcs().id).not.toBe('');
        expect(vcs().implements.port).toBe('Vcs');
        expect(vcs().implements.range).toContain(VCS_PORT_VERSION);
      });

      it('creates a worktree on a new branch at the base commit', async () => {
        const base = await testGit(box.repo, 'rev-parse', 'main');
        const path = join(box.wt, 'one');
        const info = await vcs().createWorktree({
          repo: box.repo,
          path,
          branch: playBranch('42'),
          base: 'main',
        });
        expect(info).toMatchObject({ path, branch: 'play/42/base', head: base, main: false });
        expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('hello\n');
        expect(await testGit(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('play/42/base');
        expect(await testGit(box.repo, 'rev-parse', 'play/42/base')).toBe(base);
      });

      it('accepts a sha as the base and any worktree of the repository as `repo`', async () => {
        const base = await testGit(box.repo, 'rev-parse', 'main');
        const first = await open('first', 'play/1/base');
        const second = join(box.wt, 'second');
        const info = await vcs().createWorktree({
          repo: first,
          path: second,
          branch: 'play/1/integration',
          base,
        });
        expect(info.head).toBe(base);
      });

      it('lists the main worktree first, then the others', async () => {
        const path = await open('listed', 'play/7/base');
        const list = await vcs().listWorktrees(box.repo);
        expect(list).toHaveLength(2);
        expect(list[0]).toMatchObject({ path: box.repo, branch: 'main', main: true });
        expect(list[1]).toMatchObject({ path, branch: 'play/7/base', main: false });
        expect(list[1]?.head).toBe(await testGit(path, 'rev-parse', 'HEAD'));
        // Any worktree of the repository gives the same list.
        expect(await vcs().listWorktrees(path)).toEqual(list);
      });

      it('creates the base, two attempts and the integration of one play at the same time', async () => {
        const branches = [
          playBranch('42'),
          attemptBranch('42', 'd1', 1),
          attemptBranch('42', 'd1', 2),
          integrationBranch('42'),
        ];
        await Promise.all(
          branches.map((branch, index) =>
            vcs().createWorktree({
              repo: box.repo,
              path: join(box.wt, `w${String(index)}`),
              branch,
              base: 'main',
            }),
          ),
        );
        const listed = (await vcs().listWorktrees(box.repo))
          .filter((entry) => !entry.main)
          .map((entry) => entry.branch)
          .sort();
        expect(listed).toEqual([...branches].sort());
        const refs = (
          await testGit(
            box.repo,
            'for-each-ref',
            '--format=%(refname:short)',
            'refs/heads/play/42/',
          )
        )
          .split('\n')
          .sort();
        expect(refs).toEqual([...branches].sort());
      });

      it('refuses a branch that already exists, and leaves nothing behind', async () => {
        await open('a', 'play/5/base');
        const path = join(box.wt, 'b');
        const error = await rejectionOf(
          vcs().createWorktree({ repo: box.repo, path, branch: 'play/5/base', base: 'main' }),
        );
        expect(error).toMatchObject({ code: 'CONFLICT' });
        expect(await exists(path)).toBe(false);
        expect(await vcs().listWorktrees(box.repo)).toHaveLength(2);
      });

      it('refuses a path that already exists, and a branch that git cannot hold next to another', async () => {
        const taken = join(box.wt, 'taken');
        await mkdir(taken);
        const pathError = await rejectionOf(
          vcs().createWorktree({
            repo: box.repo,
            path: taken,
            branch: 'play/6/base',
            base: 'main',
          }),
        );
        expect(pathError).toMatchObject({ code: 'CONFLICT' });
        expect(await testGit(box.repo, 'branch', '--list', 'play/6/base')).toBe('');

        await open('x', 'play/9');
        const nested = await rejectionOf(
          vcs().createWorktree({
            repo: box.repo,
            path: join(box.wt, 'y'),
            branch: 'play/9/d1/1',
            base: 'main',
          }),
        );
        expect(nested).toMatchObject({ code: 'CONFLICT' });
      });

      it('fails with a typed error for a missing repository, base or a bad name', async () => {
        const path = join(box.wt, 'z');
        expect(
          await rejectionOf(
            vcs().createWorktree({
              repo: join(box.root, 'nope'),
              path,
              branch: 'play/1/base',
              base: 'main',
            }),
          ),
        ).toMatchObject({ code: 'NOT_FOUND' });
        expect(
          await rejectionOf(
            vcs().createWorktree({ repo: box.outside, path, branch: 'play/1/base', base: 'main' }),
          ),
        ).toMatchObject({ code: 'NOT_FOUND' });
        expect(
          await rejectionOf(
            vcs().createWorktree({
              repo: box.repo,
              path,
              branch: 'play/1/base',
              base: 'no-such-ref',
            }),
          ),
        ).toMatchObject({ code: 'NOT_FOUND' });
        for (const branch of ['bad name', '-x', 'a..b', 'play/1/base.lock']) {
          expect(
            await rejectionOf(vcs().createWorktree({ repo: box.repo, path, branch, base: 'main' })),
          ).toMatchObject({ code: 'INVALID_INPUT' });
        }
        expect(await exists(path)).toBe(false);
      });

      it('commitAll commits new, changed and deleted files and returns the sha', async () => {
        const path = await open('c', 'play/2/base');
        await writeFile(join(path, 'src', 'app.txt'), 'one\nTWO\nthree\n');
        await mkdir(join(path, 'deep', 'er'), { recursive: true });
        await writeFile(join(path, 'deep', 'er', 'new.txt'), 'new\n');
        await rm(join(path, 'README.md'));
        const sha = await vcs().commitAll(path, 'work in progress');
        expect(sha).toMatch(/^[0-9a-f]{40,64}$/);
        expect(await testGit(path, 'rev-parse', 'HEAD')).toBe(sha);
        expect(await testGit(path, 'log', '-1', '--format=%s')).toBe('work in progress');
        expect(await testGit(path, 'status', '--porcelain')).toBe('');
        const tree = (await testGit(path, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
        expect(tree).toContain('deep/er/new.txt');
        expect(tree).not.toContain('README.md');
        expect(await testGit(path, 'show', 'HEAD:src/app.txt')).toBe('one\nTWO\nthree');
        // The main worktree and its branch are untouched.
        expect(await testGit(box.repo, 'log', '-1', '--format=%s', 'main')).toBe('initial commit');
      });

      it('commitAll without changes returns undefined, or an empty commit with allowEmpty', async () => {
        const path = await open('e', 'play/3/base');
        const before = await vcs().headOf(path);
        expect(await vcs().commitAll(path, 'nothing')).toBeUndefined();
        expect(await vcs().headOf(path)).toBe(before);
        const sha = await vcs().commitAll(path, 'empty on purpose', { allowEmpty: true });
        expect(sha).toBeDefined();
        expect(sha).not.toBe(before);
        expect(await testGit(path, 'rev-parse', 'HEAD~1')).toBe(before);
      });

      it('commitAll leaves ignored files out and never runs a hook', async () => {
        const path = await open('h', 'play/4/base');
        await writeFile(join(path, 'debug.log'), 'ignored\n');
        await writeFile(join(path, 'kept.txt'), 'kept\n');
        // A hook of the repository itself must not run either (hooks are off for the adapter).
        const hooks = join(
          await testGit(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
          'hooks',
        );
        await mkdir(hooks, { recursive: true });
        await writeFile(
          join(hooks, 'pre-commit'),
          `#!/bin/sh\ntouch '${join(box.root, 'hook-ran')}'\nexit 1\n`,
          {
            mode: 0o755,
          },
        );
        const sha = await vcs().commitAll(path, 'with hook around');
        expect(sha).toBeDefined();
        const tree = (await testGit(path, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
        expect(tree).toContain('kept.txt');
        expect(tree).not.toContain('debug.log');
        expect(await exists(join(box.root, 'hook-ran'))).toBe(false);
      });

      it('commitAll rejects an empty message and a folder that is not a worktree', async () => {
        const path = await open('m', 'play/8/base');
        await writeFile(join(path, 'f.txt'), 'x\n');
        expect(await rejectionOf(vcs().commitAll(path, '   '))).toMatchObject({
          code: 'INVALID_INPUT',
        });
        // `wt` is not a worktree, and it must not fall through to a repository above it.
        expect(await rejectionOf(vcs().commitAll(box.wt, 'x'))).toMatchObject({
          code: 'NOT_FOUND',
        });
        expect(await rejectionOf(vcs().commitAll(join(box.wt, 'missing'), 'x'))).toMatchObject({
          code: 'NOT_FOUND',
        });
        expect(await rejectionOf(vcs().headOf(join(box.wt, 'missing')))).toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      it('checkpoint commits with the checkpoint message, or returns undefined when clean', async () => {
        const path = await open('k', 'play/10/base');
        expect(await vcs().checkpoint(path, 'step 1')).toBeUndefined();
        await writeFile(join(path, 'work.txt'), 'partial\n');
        const sha = await vcs().checkpoint(path, 'step 1');
        expect(sha).toBeDefined();
        const subject = await testGit(path, 'log', '-1', '--format=%s');
        expect(subject).toBe(checkpointMessage('step 1'));
        expect(isCheckpointMessage(subject)).toBe(true);
        expect(await vcs().checkpoint(path, 'step 2')).toBeUndefined();
        expect(await rejectionOf(vcs().checkpoint(path, 'two\nlines'))).toMatchObject({
          code: 'INVALID_INPUT',
        });
      });

      it('headOf is the commit the worktree is at', async () => {
        const path = await open('o', 'play/11/base');
        expect(await vcs().headOf(path)).toBe(await testGit(path, 'rev-parse', 'HEAD'));
        expect(await vcs().headOf(path)).toBe(await testGit(box.repo, 'rev-parse', 'main'));
        await writeFile(join(path, 'a.txt'), 'a\n');
        const sha = await vcs().commitAll(path, 'a');
        expect(await vcs().headOf(path)).toBe(sha);
        expect(await vcs().headOf(path)).toBe(await testGit(path, 'rev-parse', 'HEAD'));
      });

      it('diffStat counts committed and uncommitted changes against the base', async () => {
        const path = await open('d', 'play/12/base');
        expect(await vcs().diffStat(path, 'main')).toEqual({
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          files: [],
        });

        await writeFile(join(path, 'src', 'app.txt'), 'one\ntwo\nthree\nfour\nfive\n');
        await vcs().commitAll(path, 'committed part'); // +2 in src/app.txt
        await writeFile(join(path, 'new.txt'), 'a\nb\nc\nd\n'); // +4, untracked
        await rm(join(path, 'README.md')); // -1, not staged
        await writeFile(join(path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3])); // binary, untracked

        const stat = await vcs().diffStat(path, 'main');
        expect(stat.filesChanged).toBe(4);
        expect(stat.insertions).toBe(6);
        expect(stat.deletions).toBe(1);
        const byPath = new Map(stat.files.map((file) => [file.path, file]));
        expect(byPath.get('src/app.txt')).toMatchObject({ insertions: 2, deletions: 0 });
        expect(byPath.get('new.txt')).toMatchObject({ insertions: 4, deletions: 0 });
        expect(byPath.get('README.md')).toMatchObject({ insertions: 0, deletions: 1 });
        expect(byPath.get('blob.bin')).toMatchObject({
          insertions: undefined,
          deletions: undefined,
        });

        // Counting must not stage anything.
        const status = await testGit(path, 'status', '--porcelain');
        expect(status).toContain('?? new.txt');
        expect(status).toContain(' D README.md');
        // A sha works as the base too.
        const sha = await testGit(box.repo, 'rev-parse', 'main');
        expect((await vcs().diffStat(path, sha)).filesChanged).toBe(4);
        expect(await rejectionOf(vcs().diffStat(path, 'no-such-ref'))).toMatchObject({
          code: 'NOT_FOUND',
        });
      });

      describe('.worktreeinclude', () => {
        beforeEach(async () => {
          await writeFile(join(box.repo, '.env'), 'TOKEN=test\n');
          await mkdir(join(box.repo, 'secret', 'deep'), { recursive: true });
          await writeFile(join(box.repo, 'secret', 'key.txt'), 'key\n');
          await writeFile(join(box.repo, 'secret', 'deep', 'more.txt'), 'more\n');
          await writeFile(join(box.repo, 'build.log'), 'ignored but not listed\n');
          await writeFile(join(box.repo, 'notes.txt'), 'listed but not ignored\n');
          await symlink(join(box.outside, OUTSIDE_FILE), join(box.repo, 'leak.txt'));
          await symlink(box.outside, join(box.repo, 'linkdir'));
        });

        it('copies what it lists and git ignores, and nothing else', async () => {
          const path = await open('inc', 'play/20/base');
          expect(await readFile(join(path, '.env'), 'utf8')).toBe('TOKEN=test\n');
          expect(await readFile(join(path, 'secret', 'key.txt'), 'utf8')).toBe('key\n');
          expect(await readFile(join(path, 'secret', 'deep', 'more.txt'), 'utf8')).toBe('more\n');
          // Ignored, but not listed.
          expect(await exists(join(path, 'build.log'))).toBe(false);
          // Listed, but not ignored by git (ccmanager's rule: both are needed).
          expect(await exists(join(path, 'notes.txt'))).toBe(false);
          // The copied files stay untracked.
          expect(await testGit(path, 'status', '--porcelain')).toBe('');
          expect(await vcs().commitAll(path, 'nothing to add')).toBeUndefined();
        });

        it('never follows or copies a symbolic link, and never copies .git', async () => {
          const path = await open('links', 'play/21/base');
          expect(await exists(join(path, 'leak.txt'))).toBe(false);
          expect(await exists(join(path, 'linkdir'))).toBe(false);
          expect((await stat(join(path, '.git'))).isFile()).toBe(true);
          expect(await readdir(box.outside)).toEqual([OUTSIDE_FILE]);
          expect(await readFile(join(box.outside, OUTSIDE_FILE), 'utf8')).toBe(OUTSIDE_CONTENT);
        });

        it('does not overwrite a tracked file and does not fail without the file', async () => {
          await testGit(box.repo, 'rm', '--quiet', '-f', '.worktreeinclude');
          await testGit(box.repo, 'commit', '--quiet', '-m', 'drop the include file');
          const path = await open('none', 'play/22/base');
          expect(await exists(join(path, '.env'))).toBe(false);
          expect(await exists(join(path, 'README.md'))).toBe(true);
        });
      });

      describe('removeWorktree', () => {
        it('removes a clean worktree, keeping its branch by default', async () => {
          const path = await open('r1', 'play/30/base');
          await vcs().removeWorktree(path);
          expect(await exists(path)).toBe(false);
          expect(await vcs().listWorktrees(box.repo)).toHaveLength(1);
          expect(await testGit(box.repo, 'branch', '--list', 'play/30/base')).toContain(
            'play/30/base',
          );
        });

        it('refuses a dirty worktree without force, and removes it with force', async () => {
          const path = await open('r2', 'play/31/base');
          await writeFile(join(path, 'dirty.txt'), 'x\n');
          expect(await rejectionOf(vcs().removeWorktree(path))).toMatchObject({ code: 'CONFLICT' });
          expect(await exists(join(path, 'dirty.txt'))).toBe(true);
          expect(await vcs().listWorktrees(box.repo)).toHaveLength(2);

          await vcs().removeWorktree(path, { force: true });
          expect(await exists(path)).toBe(false);
          expect(await vcs().listWorktrees(box.repo)).toHaveLength(1);
        });

        it('with deleteBranch also deletes the branch, even with checkpoints on it', async () => {
          const path = await open('r3', 'play/32/base');
          await writeFile(join(path, 'w.txt'), 'w\n');
          await vcs().checkpoint(path, 'saved');
          await vcs().removeWorktree(path, { deleteBranch: true });
          expect(await testGit(box.repo, 'branch', '--list', 'play/32/base')).toBe('');
        });

        it('rejects a path that is not a worktree, and the main worktree', async () => {
          expect(await rejectionOf(vcs().removeWorktree(join(box.wt, 'missing')))).toMatchObject({
            code: 'NOT_FOUND',
          });
          expect(await rejectionOf(vcs().removeWorktree(box.wt))).toMatchObject({
            code: 'NOT_FOUND',
          });
          const error = await rejectionOf(vcs().removeWorktree(box.repo, { force: true }));
          expect(isOTheaterError(error)).toBe(true);
          expect(await exists(join(box.repo, '.git'))).toBe(true);
        });
      });

      it('writes nothing outside the temporary repository and the worktree folder', async () => {
        const before = await readdir(box.outside);
        const a = await open('n1', attemptBranch('50', 'd1', 1));
        const b = await open('n2', attemptBranch('50', 'd1', 2));
        await writeFile(join(a, 'x.txt'), 'x\n');
        await vcs().checkpoint(a, 'x');
        await vcs().commitAll(b, 'empty', { allowEmpty: true });
        await vcs().diffStat(a, 'main');
        await vcs().removeWorktree(b, { deleteBranch: true });
        await vcs().removeWorktree(a, { force: true });
        expect((await readdir(box.root)).sort()).toEqual(['outside', 'repo', 'wt']);
        expect(await readdir(box.wt)).toEqual([]);
        expect(await readdir(box.outside)).toEqual(before);
        expect(await readFile(join(box.outside, OUTSIDE_FILE), 'utf8')).toBe(OUTSIDE_CONTENT);
      });
    },
  );
}
