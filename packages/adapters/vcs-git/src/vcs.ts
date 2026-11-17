// SPDX-License-Identifier: MPL-2.0
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import {
  Conflict,
  InvalidInput,
  NotFound,
  VCS_PORT_VERSION,
  checkpointMessage,
  playBranchPrefix,
  type Adapter,
  type CommitOptions,
  type CreateWorktreeOptions,
  type InitOptions,
  type DiffStat,
  type DiffStatFile,
  type MergeOptions,
  type MergeOutcome,
  type RemoveWorktreeOptions,
  type Vcs,
  type VcsHistory,
  type VcsInit,
  type VcsMerge,
  type WorktreeInfo,
} from '@otheater/core';
import { classifyGitFailure, GitRunner, type GitRunnerOptions } from './git.js';
import { copyWorktreeInclude, type WorktreeIncludeResult } from './worktree-include.js';

/** Identity of this adapter for the composition point (architecture 5.18). */
export const GIT_VCS_ADAPTER: Adapter = {
  id: 'git',
  implements: { port: 'Vcs', range: `^${VCS_PORT_VERSION}` },
};

export interface GitVcsOptions extends GitRunnerOptions {
  /**
   * Copy the files listed in `.worktreeinclude` into each new worktree (architecture 5.5).
   * Default true.
   */
  readonly worktreeInclude?: boolean;
  /** Told about what the `.worktreeinclude` copy left out; a skip never fails `createWorktree`. */
  readonly onWarning?: (message: string) => void;
}

const BRANCH_REF_PREFIX = 'refs/heads/';

/** Most commits `findCommitByTrailer` looks through, newest first. [proposta] */
const TRAILER_SEARCH_LIMIT = 5000;

const TRAILER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The `Vcs` port over the `git` CLI (architecture 5.5, 5.16). Every command runs with
 * `execFile` and an argument array, in the isolated environment of {@link GitRunner}: the
 * user's git configuration is neither read nor written, and no hook runs.
 *
 * Operations that change the shared state of a repository (branches, worktree registry) are
 * serialized per repository inside this process, so several attempts of one play can be created
 * at once without fighting over git's own lock files.
 */
export class GitVcs implements Vcs, VcsMerge, VcsHistory, VcsInit {
  readonly id = GIT_VCS_ADAPTER.id;
  readonly implements = GIT_VCS_ADAPTER.implements;

  readonly #git: GitRunner;
  readonly #include: boolean;
  readonly #warn: (message: string) => void;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: GitVcsOptions = {}) {
    this.#git = new GitRunner(options);
    this.#include = options.worktreeInclude ?? true;
    this.#warn = options.onWarning ?? (() => undefined);
  }

  async createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    assertAbsolute('repo', opts.repo);
    assertAbsolute('path', opts.path);
    assertText('branch', opts.branch);
    assertText('base', opts.base);
    if (opts.branch.startsWith('-') || opts.base.startsWith('-')) {
      throw new InvalidInput('A branch or base name cannot start with "-"');
    }

    const commonDir = await this.#commonDir(opts.repo);
    const valid = await this.#git.try(opts.repo, ['check-ref-format', '--branch', opts.branch]);
    if (valid.code !== 0 || opts.branch.includes('@{')) {
      throw new InvalidInput(`Invalid branch name: ${JSON.stringify(opts.branch)}`);
    }
    const head = await this.#resolveCommit(opts.repo, opts.base);

    return this.#locked(commonDir, async () => {
      if (await this.#branchExists(opts.repo, opts.branch)) {
        throw new Conflict(`Branch already exists: ${opts.branch}`);
      }
      if (await pathExists(opts.path)) {
        throw new Conflict(`Worktree path already exists: ${opts.path}`);
      }
      await this.#git.run(opts.repo, [
        'worktree',
        'add',
        '--quiet',
        '--no-track',
        '-b',
        opts.branch,
        '--',
        opts.path,
        head,
      ]);
      if (this.#include) await this.#copyInclude(opts.repo, opts.path);
      return { path: opts.path, branch: opts.branch, head, main: false };
    });
  }

  async init(
    folder: string,
    opts: InitOptions = {},
  ): Promise<{ readonly branch: string; readonly head: string }> {
    assertAbsolute('folder', folder);
    const branch = opts.branch ?? 'main';
    assertText('branch', branch);
    if (branch.startsWith('-')) throw new InvalidInput('A branch name cannot start with "-"');
    const valid = await this.#git.try(tmpdir(), ['check-ref-format', '--branch', branch]);
    if (valid.code !== 0 || branch.includes('@{')) {
      throw new InvalidInput(`Invalid branch name: ${JSON.stringify(branch)}`);
    }
    await mkdir(folder, { recursive: true });
    const real = await realpath(folder);
    // A folder inside another repository would otherwise "already be one": it must be the root.
    const top = await this.#git.try(real, ['rev-parse', '--show-toplevel']);
    const isRoot = top.code === 0 && (await realpathOrSelf(top.stdout.trim())) === real;
    if (!isRoot) await this.#git.run(real, ['init', '--quiet', `--initial-branch=${branch}`]);
    const head = await this.#git.try(real, ['rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) {
      await this.#git.run(real, [
        'commit',
        '--quiet',
        '--no-verify',
        '--no-gpg-sign',
        '--allow-empty',
        '-m',
        opts.message ?? 'Initial commit',
      ]);
    }
    const current = (await this.#git.run(real, ['symbolic-ref', '--short', 'HEAD'])).trim();
    return { branch: current, head: await this.#head(real) };
  }

  async removeWorktree(worktree: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
    const root = await this.#worktreeRoot(worktree);
    const worktrees = await this.listWorktrees(root);
    const entries = await Promise.all(
      worktrees.map(async (entry) => ({ entry, real: await realpathOrSelf(entry.path) })),
    );
    const found = entries.find((candidate) => candidate.real === root);
    if (found === undefined) throw new NotFound(`Not a registered worktree: ${worktree}`);
    if (found.entry.main) throw new InvalidInput('The main worktree cannot be removed');
    const main = worktrees.find((entry) => entry.main);
    const mainPath = main?.path ?? root;

    const commonDir = await this.#commonDir(root);
    await this.#locked(commonDir, async () => {
      if (opts.force !== true && (await this.#isDirty(root))) {
        throw new Conflict(`The worktree has uncommitted changes: ${worktree}`);
      }
      const args = ['worktree', 'remove'];
      if (opts.force === true) args.push('--force');
      await this.#git.run(mainPath, [...args, '--', root]);
      const branch = found.entry.branch;
      if (opts.deleteBranch === true && branch !== undefined) {
        await this.#git.run(mainPath, ['branch', '-D', '--', branch]);
      }
    });
  }

  async listWorktrees(repo: string): Promise<readonly WorktreeInfo[]> {
    assertAbsolute('repo', repo);
    const output = await this.#git.run(repo, ['worktree', 'list', '--porcelain', '-z']);
    // Git prints `C:/dir` on Windows; the port speaks native paths, like the ones it was given.
    return parseWorktreeList(output).map((entry) => ({ ...entry, path: normalize(entry.path) }));
  }

  async commitAll(
    worktree: string,
    message: string,
    opts: CommitOptions = {},
  ): Promise<string | undefined> {
    assertText('commit message', message);
    if (message.trim() === '') throw new InvalidInput('A commit message cannot be empty');
    const root = await this.#worktreeRoot(worktree);
    await this.#git.run(root, ['add', '-A', '--']);
    const staged = await this.#git.try(root, ['diff', '--cached', '--quiet']);
    if (staged.code === 0 && opts.allowEmpty !== true) return undefined;
    if (staged.code > 1) {
      throw new Conflict(`git diff --cached failed: ${staged.stderr.trim()}`);
    }
    const args = ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace'];
    if (opts.allowEmpty === true) args.push('--allow-empty');
    await this.#git.run(root, [...args, '-m', message]);
    return this.#head(root);
  }

  async checkpoint(worktree: string, label: string): Promise<string | undefined> {
    // `async`: an invalid label rejects, like every other bad input, instead of throwing.
    return this.commitAll(worktree, checkpointMessage(label));
  }

  async headOf(worktree: string): Promise<string> {
    return this.#head(await this.#worktreeRoot(worktree));
  }

  /**
   * Compares the working tree of `worktree` (committed and uncommitted, new files included) with
   * `base` directly, as `git diff <base>` does: it is not a diff from the merge base. New files
   * are counted through a throwaway copy of the index, so the real index is never touched.
   */
  async diffStat(worktree: string, base: string): Promise<DiffStat> {
    assertText('base', base);
    if (base.startsWith('-')) throw new InvalidInput('A base name cannot start with "-"');
    const root = await this.#worktreeRoot(worktree);
    const baseSha = await this.#resolveCommit(root, base);
    const indexPath = (
      await this.#git.run(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    ).trim();
    const scratch = await mkdtemp(join(tmpdir(), 'otheater-index-'));
    try {
      const copy = join(scratch, 'index');
      try {
        await copyFile(indexPath, copy);
      } catch (error) {
        // No index yet: an empty one is the same thing for `add -A`.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const env = { GIT_INDEX_FILE: copy };
      await this.#git.run(root, ['add', '-A', '--'], { env });
      const output = await this.#git.run(
        root,
        ['diff', '--cached', '--numstat', '-z', '--no-renames', baseSha, '--'],
        { env },
      );
      return parseNumstat(output);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Merges `ref` into the branch of `worktree` with a merge commit (`--no-ff`: one commit per
   * merged attempt stays in the history). A conflict is the `conflict` outcome, never an error:
   * the merge is aborted, so the worktree is clean again and keeps its branch at the same commit.
   */
  async merge(worktree: string, ref: string, opts: MergeOptions = {}): Promise<MergeOutcome> {
    assertText('ref', ref);
    if (ref.startsWith('-')) throw new InvalidInput('A ref cannot start with "-"');
    const message = opts.message ?? `Merge ${ref}`;
    assertText('merge message', message);
    const root = await this.#worktreeRoot(worktree);
    const target = await this.#resolveCommit(root, ref);
    const commonDir = await this.#commonDir(root);
    return this.#locked(commonDir, async () => {
      if (await this.#isDirty(root)) {
        throw new Conflict(`The worktree has uncommitted changes: ${worktree}`);
      }
      const head = await this.#head(root);
      const contained = await this.#git.try(root, ['merge-base', '--is-ancestor', target, head]);
      if (contained.code === 0) return { kind: 'up_to_date', sha: head };
      if (contained.code !== 1) {
        throw new Conflict(`git merge-base failed: ${contained.stderr.trim()}`);
      }
      const result = await this.#git.try(root, [
        'merge',
        '--no-ff',
        '--no-edit',
        '--quiet',
        '-m',
        message,
        target,
      ]);
      if (result.code === 0) return { kind: 'merged', sha: await this.#head(root) };
      const unmerged = await this.#git.run(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
      const files = unmerged
        .split('\0')
        .filter((file) => file !== '')
        .sort();
      // Whatever else it was (an unrelated history, a lock), the merge must not stay half done.
      await this.#git.try(root, ['merge', '--abort']);
      if (files.length === 0) {
        throw classifyGitFailure(
          ['merge', ref],
          Object.assign(new Error('git merge failed'), { code: result.code }),
          result.stderr || result.stdout,
          this.#git.timeoutMs,
        );
      }
      return { kind: 'conflict', files };
    });
  }

  async resolveRef(repo: string, ref: string): Promise<string> {
    assertAbsolute('repo', repo);
    assertText('ref', ref);
    if (ref.startsWith('-')) throw new InvalidInput('A ref cannot start with "-"');
    return this.#resolveCommit(repo, ref);
  }

  async findCommitByTrailer(
    repo: string,
    ref: string,
    key: string,
    value: string,
  ): Promise<string | undefined> {
    if (!TRAILER_KEY.test(key))
      throw new InvalidInput(`Invalid trailer key: ${JSON.stringify(key)}`);
    assertText('trailer value', value);
    const tip = await this.resolveRef(repo, ref);
    const output = await this.#git.run(repo, [
      'log',
      `--max-count=${String(TRAILER_SEARCH_LIMIT)}`,
      `--format=%H%x00%(trailers:key=${key},valueonly=true,unfold=true,separator=%x1f)%x1e`,
      tip,
      '--',
    ]);
    for (const record of output.split('\x1e')) {
      const [sha, trailers] = record.replace(/^\n/, '').split('\0');
      if (sha === undefined || sha === '' || trailers === undefined) continue;
      if (trailers.split('\x1f').some((found) => found.trim() === value)) return sha;
    }
    return undefined;
  }

  /**
   * Branches of one play, every one under `play/<id>/` (N59), as `play/<id>/base`,
   * `play/<id>/attempts/<demand>/<n>` and `play/<id>/integration`. [proposta] extra method of
   * the adapter; the port has no way to list a play's branches.
   */
  async listPlayBranches(repo: string, playId: string): Promise<readonly string[]> {
    assertAbsolute('repo', repo);
    const prefix = playBranchPrefix(playId);
    const output = await this.#git.run(repo, [
      'for-each-ref',
      '--format=%(refname)',
      `${BRANCH_REF_PREFIX}${prefix}`,
    ]);
    return output
      .split('\n')
      .filter((line) => line !== '')
      .map((ref) => ref.slice(BRANCH_REF_PREFIX.length));
  }

  /**
   * Deletes every branch of one play (end-of-play cleanup, architecture 5.5, "Limpeza"). Refuses
   * with `Conflict`, deleting nothing, while one of them is checked out in a worktree: remove
   * those first. Returns the branches deleted. [proposta] extra method of the adapter.
   */
  async deletePlayBranches(repo: string, playId: string): Promise<readonly string[]> {
    assertAbsolute('repo', repo);
    const commonDir = await this.#commonDir(repo);
    return this.#locked(commonDir, async () => {
      const branches = await this.listPlayBranches(repo, playId);
      if (branches.length === 0) return [];
      const inUse = new Set(
        (await this.listWorktrees(repo)).flatMap((entry) =>
          entry.branch === undefined ? [] : [entry.branch],
        ),
      );
      const busy = branches.filter((branch) => inUse.has(branch));
      if (busy.length > 0) {
        throw new Conflict(`Branches still checked out in a worktree: ${busy.join(', ')}`);
      }
      await this.#git.run(repo, ['branch', '-D', '--', ...branches]);
      return branches;
    });
  }

  /**
   * Copies the `.worktreeinclude` files of the main worktree of `repo` into `worktree` (already
   * done by `createWorktree`; public to redo it or to run it on its own).
   */
  async copyWorktreeInclude(repo: string, worktree: string): Promise<WorktreeIncludeResult> {
    assertAbsolute('repo', repo);
    assertAbsolute('worktree', worktree);
    const main = (await this.listWorktrees(repo)).find((entry) => entry.main);
    if (main === undefined) throw new NotFound(`No main worktree in ${repo}`);
    return copyWorktreeInclude(this.#git, main.path, worktree);
  }

  async #copyInclude(repo: string, worktree: string): Promise<void> {
    try {
      const result = await this.copyWorktreeInclude(repo, worktree);
      for (const skip of result.skipped) {
        this.#warn(`.worktreeinclude: ${skip.path} not copied (${skip.reason})`);
      }
    } catch (error) {
      // The worktree exists and is usable; a missing .env must not undo that.
      this.#warn(
        `.worktreeinclude copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #head(root: string): Promise<string> {
    return (await this.#git.run(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  }

  async #commonDir(dir: string): Promise<string> {
    const output = await this.#git.run(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    return realpathOrSelf(output.trim());
  }

  async #resolveCommit(dir: string, ref: string): Promise<string> {
    const result = await this.#git.try(dir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    const sha = result.stdout.trim();
    if (result.code !== 0 || sha === '') throw new NotFound(`Ref not found: ${ref}`);
    return sha;
  }

  async #branchExists(dir: string, branch: string): Promise<boolean> {
    const result = await this.#git.try(dir, [
      'show-ref',
      '--verify',
      '--quiet',
      `${BRANCH_REF_PREFIX}${branch}`,
    ]);
    return result.code === 0;
  }

  async #isDirty(root: string): Promise<boolean> {
    const status = await this.#git.run(root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
    ]);
    return status !== '';
  }

  /** The real path of `worktree`, after checking that it is the root of a worktree. */
  async #worktreeRoot(worktree: string): Promise<string> {
    assertAbsolute('worktree', worktree);
    let real: string;
    try {
      real = await realpath(worktree);
    } catch (error) {
      throw new NotFound(`Worktree not found: ${worktree}`, { cause: error });
    }
    const top = (await this.#git.run(real, ['rev-parse', '--show-toplevel'])).trim();
    // A folder that is not a worktree would otherwise act on whatever repository contains it.
    if ((await realpathOrSelf(top)) !== real) {
      throw new NotFound(`Not the root of a worktree: ${worktree}`);
    }
    return real;
  }

  async #locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}

function assertAbsolute(what: string, path: string): void {
  assertText(what, path);
  if (!isAbsolute(path)) throw new InvalidInput(`${what} must be an absolute path: ${path}`);
}

function assertText(what: string, value: string): void {
  if (value === '' || value.includes('\0')) {
    throw new InvalidInput(`Invalid ${what}: it is empty or has a NUL character`);
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parses `git worktree list --porcelain -z`. A bare repository entry has no commit: skipped. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let index = 0;
  let current: { path?: string; head?: string; branch?: string; bare: boolean } | undefined;
  const flush = (): void => {
    if (current?.path !== undefined && current.head !== undefined && !current.bare) {
      result.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        main: index === 0,
      });
    }
    if (current !== undefined) index += 1;
    current = undefined;
  };
  for (const field of output.split('\0')) {
    if (field === '') {
      flush();
      continue;
    }
    current ??= { bare: false };
    if (field.startsWith('worktree ')) current.path = field.slice('worktree '.length);
    else if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch ')) {
      const ref = field.slice('branch '.length);
      current.branch = ref.startsWith(BRANCH_REF_PREFIX)
        ? ref.slice(BRANCH_REF_PREFIX.length)
        : ref;
    } else if (field === 'bare') current.bare = true;
  }
  flush();
  return result;
}

/** Parses `git diff --numstat -z --no-renames`: `<ins>\t<del>\t<path>` records, `-` if binary. */
export function parseNumstat(output: string): DiffStat {
  const files: DiffStatFile[] = [];
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const insertions = record.slice(0, first);
    const deletions = record.slice(first + 1, second);
    files.push({
      path: record.slice(second + 1),
      insertions: insertions === '-' ? undefined : Number(insertions),
      deletions: deletions === '-' ? undefined : Number(deletions),
    });
  }
  return {
    filesChanged: files.length,
    insertions: files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    files,
  };
}
