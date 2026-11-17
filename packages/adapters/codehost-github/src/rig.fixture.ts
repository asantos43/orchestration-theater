// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testGit } from '@otheater/sdk';
import { GithubCodeHost } from './code-host.js';
import type { GithubCodeHostConfigInput } from './config.js';
import { FAKE_GH_SOURCE } from './fake-gh.fixture.js';
import { SpawnLauncher } from './spawn-launcher.fixture.js';

export interface GhCall {
  readonly args: string[];
  /** Names of the environment variables the fake `gh` saw. */
  readonly env: string[];
}

export interface GithubRig {
  readonly root: string;
  /** The bare repository the fake host serves (the "remote"). */
  readonly remote: string;
  /** A checkout of it, with `origin` pointing at the bare repository. */
  readonly repo: string;
  readonly launcher: SpawnLauncher;
  readonly codeHost: GithubCodeHost;
  /** Adds one commit to the local `branch` (created from `main`); nothing is pushed. */
  readonly commit: (branch: string) => Promise<string>;
  /** Rewrites the (pushed) local branch so it no longer descends from the remote's. */
  readonly diverge: (branch: string) => Promise<string>;
  /** Local `head` and one commit on `main` that conflict with each other. */
  readonly conflict: (head: string) => Promise<void>;
  /** What the fake `gh` was called with, in order. */
  ghCalls(): Promise<GhCall[]>;
  dispose(): Promise<void>;
}

export interface RigOptions {
  readonly config?: GithubCodeHostConfigInput;
  /** Variables of the "parent" environment the tools inherit from, besides PATH and HOME. */
  readonly parentEnv?: Record<string, string>;
}

/**
 * A GitHub `CodeHost` over a fake `gh` (a node script written to a temporary folder) and a real
 * bare repository. The real `gh` never runs: `ghBinary` points at the script, and the tools get a
 * `HOME` and a git configuration of their own, so nothing of the machine's leaks in.
 */
export async function makeGithubRig(options: RigOptions = {}): Promise<GithubRig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-codehost-')));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const ghDir = join(root, 'gh');
  const home = join(root, 'home');
  const ghBinary = join(ghDir, 'gh');
  await Promise.all([mkdir(remote), mkdir(repo), mkdir(ghDir), mkdir(home)]);
  await writeFile(ghBinary, FAKE_GH_SOURCE);
  await chmod(ghBinary, 0o755);
  await writeFile(join(home, 'gitconfig'), '');

  await testGit(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
  await testGit(repo, 'remote', 'add', 'origin', remote);
  await testGit(repo, 'push', '--quiet', 'origin', 'main');

  const launcher = new SpawnLauncher();
  const codeHost = new GithubCodeHost({
    launcher,
    parentEnv: { PATH: process.env.PATH ?? '', HOME: home, ...options.parentEnv },
    config: {
      ghBinary,
      ...options.config,
      env: {
        FAKE_GH_DIR: ghDir,
        FAKE_GH_REMOTE: remote,
        // The git the tools run sees no configuration of the machine: no hooks, no signing.
        GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        ...options.config?.env,
      },
    },
  });

  let counter = 0;
  const checkout = async (branch: string): Promise<void> => {
    await testGit(repo, 'checkout', '--quiet', branch);
  };
  const exists = async (branch: string): Promise<boolean> => {
    try {
      await testGit(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  };

  return {
    root,
    remote,
    repo,
    launcher,
    codeHost,
    async commit(branch) {
      counter += 1;
      if (await exists(branch)) await checkout(branch);
      else await testGit(repo, 'checkout', '--quiet', '-b', branch, 'main');
      await writeFile(join(repo, `file-${String(counter)}.txt`), `content ${String(counter)}\n`);
      await testGit(repo, 'add', '-A');
      await testGit(repo, 'commit', '--quiet', '-m', `commit ${String(counter)}`);
      const sha = await testGit(repo, 'rev-parse', 'HEAD');
      await checkout('main');
      return sha;
    },
    async diverge(branch) {
      await checkout(branch);
      await testGit(repo, 'commit', '--quiet', '--amend', '--allow-empty', '-m', 'rewritten');
      const sha = await testGit(repo, 'rev-parse', 'HEAD');
      await checkout('main');
      return sha;
    },
    async conflict(head) {
      await testGit(repo, 'checkout', '--quiet', '-b', head, 'main');
      await writeFile(join(repo, 'shared.txt'), 'head side\n');
      await testGit(repo, 'commit', '--quiet', '-am', 'head side');
      await checkout('main');
      await writeFile(join(repo, 'shared.txt'), 'base side\n');
      await testGit(repo, 'commit', '--quiet', '-am', 'base side');
    },
    async ghCalls() {
      let text: string;
      try {
        text = await readFile(join(ghDir, 'calls.log'), 'utf8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as GhCall);
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The harness of the `CodeHost` conformance suite over a rig. */
export async function codeHostHarness(options: RigOptions = {}): Promise<{
  codeHost: GithubCodeHost;
  repo: string;
  baseBranch: string;
  commit: GithubRig['commit'];
  diverge: GithubRig['diverge'];
  conflict: GithubRig['conflict'];
  dispose: () => Promise<void>;
}> {
  const rig = await makeGithubRig(options);
  return {
    codeHost: rig.codeHost,
    repo: rig.repo,
    baseBranch: 'main',
    commit: rig.commit,
    diverge: rig.diverge,
    conflict: rig.conflict,
    dispose: () => rig.dispose(),
  };
}
