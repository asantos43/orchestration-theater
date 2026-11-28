// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IssueState } from '@otheater/core';
import { testGit, type CiRunSeed, type IssueSeed, type IssueTrackerHarness } from '@otheater/sdk';
import { GithubCodeHost } from './code-host.js';
import type { GithubCodeHostConfigInput } from './config.js';
import { FAKE_GH_SOURCE } from './fake-gh.fixture.js';
import { GithubIssueTracker } from './issue-tracker.js';
import { GithubRepoReader } from './repo-reader.js';
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
  /** An `IssueTracker` over the same fake `gh` and configuration. */
  readonly issueTracker: GithubIssueTracker;
  /** The pull request lister and the collaborator check of the triggers, over the same fake `gh`. */
  readonly reader: GithubRepoReader;
  /** Makes `login` a user of the fake host with this permission (`admin`, `write`, `read`, `none`). */
  readonly seedCollaborator: (login: string, permission: string) => Promise<void>;
  /** Sets who opened a pull request, its labels and its update time (ISO), as the fake host keeps them. */
  readonly touchPullRequest: (
    number: number,
    change: { author?: string; labels?: string[]; updatedAt?: string },
  ) => Promise<void>;
  /** Adds one commit to the local `branch` (created from `main`); nothing is pushed. */
  readonly commit: (branch: string) => Promise<string>;
  /** Rewrites the (pushed) local branch so it no longer descends from the remote's. */
  readonly diverge: (branch: string) => Promise<string>;
  /** Local `head` and one commit on `main` that conflict with each other. */
  readonly conflict: (head: string) => Promise<void>;
  /** Puts an issue on the fake host (opened by `author`, default `fake-user`); returns its number. */
  readonly seedIssue: (issue: IssueSeed & { readonly author?: string | null }) => Promise<number>;
  /** Pushes a new branch and opens a pull request of it into `main`; returns its number. */
  readonly seedPullRequest: () => Promise<number>;
  /** Puts a completed CI run on the commit `sha`. Returns its id. */
  readonly seedCiRun: (sha: string, run: CiRunSeed) => Promise<number>;
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

  const launcher = new SpawnLauncher({ nodeScripts: [ghBinary] });
  const hostOptions = {
    launcher,
    parentEnv: { ...windowsEnv(), PATH: process.env.PATH ?? '', HOME: home, ...options.parentEnv },
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
  };
  const codeHost = new GithubCodeHost(hostOptions);
  const issueTracker = new GithubIssueTracker(hostOptions);
  const reader = new GithubRepoReader(hostOptions);

  const readState = async <T>(name: string): Promise<T[]> => {
    try {
      return JSON.parse(await readFile(join(ghDir, name), 'utf8')) as T[];
    } catch {
      return [];
    }
  };
  // Each seeded item is newer than the one before, also within one millisecond.
  let lastTime = 0;
  const nextTime = (): string => {
    lastTime = Math.max(Date.now(), lastTime + 1);
    return new Date(lastTime).toISOString();
  };
  let runCounter = 1000;

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

  const commit = async (branch: string): Promise<string> => {
    counter += 1;
    if (await exists(branch)) await checkout(branch);
    else await testGit(repo, 'checkout', '--quiet', '-b', branch, 'main');
    await writeFile(join(repo, `file-${String(counter)}.txt`), `content ${String(counter)}\n`);
    await testGit(repo, 'add', '-A');
    await testGit(repo, 'commit', '--quiet', '-m', `commit ${String(counter)}`);
    const sha = await testGit(repo, 'rev-parse', 'HEAD');
    await checkout('main');
    return sha;
  };

  return {
    root,
    remote,
    repo,
    launcher,
    codeHost,
    issueTracker,
    reader,
    async seedCollaborator(login, permission) {
      const known = await readState<{ login: string; permission: string }>('collaborators.json');
      known.push({ login, permission });
      await writeFile(join(ghDir, 'collaborators.json'), JSON.stringify(known));
    },
    async touchPullRequest(number, change) {
      const pulls = await readState<Record<string, unknown> & { number: number }>('prs.json');
      const next = pulls.map((entry) =>
        entry.number === number
          ? {
              ...entry,
              ...(change.author === undefined ? {} : { author: change.author }),
              ...(change.labels === undefined ? {} : { labels: change.labels }),
              ...(change.updatedAt === undefined ? {} : { updatedAt: change.updatedAt }),
            }
          : entry,
      );
      await writeFile(join(ghDir, 'prs.json'), JSON.stringify(next));
    },
    commit,
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
    async seedIssue(issue) {
      const [pulls, issues] = await Promise.all([
        readState<{ number: number }>('prs.json'),
        readState<Record<string, unknown> & { number: number }>('issues.json'),
      ]);
      const number = Math.max(0, ...pulls.map((p) => p.number), ...issues.map((i) => i.number)) + 1;
      const time = nextTime();
      const state: IssueState = issue.state ?? 'open';
      issues.push({
        number,
        url: `https://github.invalid/owner/repo/issues/${String(number)}`,
        title: issue.title,
        body: issue.body ?? '',
        state,
        labels: [...(issue.labels ?? [])],
        user: issue.author === undefined ? 'fake-user' : issue.author,
        created_at: time,
        updated_at: time,
      });
      await writeFile(join(ghDir, 'issues.json'), JSON.stringify(issues));
      return number;
    },
    async seedPullRequest() {
      counter += 1;
      const branch = `pr-${String(counter)}`;
      await commit(branch);
      await codeHost.pushRef({ repo, branch });
      // `pr create` stamps the time itself; the seeded issues around it keep the order.
      nextTime();
      const pull = await codeHost.openPullRequest({
        repo,
        head: branch,
        base: 'main',
        title: `pull request of ${branch}`,
        body: '',
      });
      return pull.number;
    },
    async seedCiRun(sha, run) {
      runCounter += 1;
      const id = runCounter;
      const runs = await readState<Record<string, unknown>>('runs.json');
      runs.push({
        id,
        name: run.name,
        head_sha: sha,
        status: 'completed',
        conclusion: run.conclusion,
        html_url: `https://github.invalid/owner/repo/actions/runs/${String(id)}`,
        created_at: nextTime(),
      });
      await mkdir(join(ghDir, 'logs'), { recursive: true });
      await Promise.all([
        writeFile(join(ghDir, 'runs.json'), JSON.stringify(runs)),
        writeFile(join(ghDir, 'logs', `${String(id)}.txt`), run.log),
      ]);
      return id;
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

/**
 * What Windows needs to start a process (inherited by default, see `DEFAULT_INHERITED_ENV`), when
 * the host has it; nothing on the other systems.
 */
function windowsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The harness of the `CodeHost` conformance suite over a rig. */
export async function codeHostHarness(options: RigOptions = {}): Promise<{
  codeHost: GithubCodeHost;
  repo: string;
  baseBranch: string;
  commit: GithubRig['commit'];
  diverge: GithubRig['diverge'];
  conflict: GithubRig['conflict'];
  seedCiRun: (sha: string, run: CiRunSeed) => Promise<void>;
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
    seedCiRun: async (sha, run) => {
      await rig.seedCiRun(sha, run);
    },
    dispose: () => rig.dispose(),
  };
}

/** The harness of the `IssueTracker` conformance suite over a rig. */
export async function issueTrackerHarness(options: RigOptions = {}): Promise<IssueTrackerHarness> {
  const rig = await makeGithubRig(options);
  return {
    issueTracker: rig.issueTracker,
    repo: rig.repo,
    seedIssue: (issue) => rig.seedIssue(issue),
    seedPullRequest: () => rig.seedPullRequest(),
    dispose: () => rig.dispose(),
  };
}
