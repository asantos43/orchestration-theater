// SPDX-License-Identifier: MPL-2.0
// Shared by the end-to-end test of the chat only (excluded from the build of the package).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createNodeDaemonDirectory } from '@otheater/client/node';
import type {
  Adapter,
  AdapterImplements,
  BranchTarget,
  ClientAdapter,
  Clock,
  CodeHost,
  EventEnvelope,
  FindPullRequestOptions,
  MergeBranchOptions,
  MergeBranchResult,
  OpenPullRequestOptions,
  PlayRecord,
  ProcessLauncher,
  PullRequest,
  SecretVault,
} from '@otheater/core';
import {
  createSilentLogger,
  defaultLauncher,
  parseConfig,
  productionClients,
  startDaemon,
  type DaemonHandle,
} from '@otheater/daemon';
import { directoryConnector, type DaemonConnector } from '../daemon-connection.js';

/**
 * A real daemon in this process with the fake agent in every role, for the acceptance of the chat
 * (P12): the TUI types into the chat, the Director (the fake agent) answers, the plays run and the
 * decisions come back. It is the fixture of the daemon (`orchestration/e2e-fixture.ts`) made for the
 * TUI package: the daemon may not import the TUI (rule `tui-launcher-only-from-cli`), and the
 * fixture of the daemon is not in the index of its package. Nothing real runs (N57): temporary
 * folders, loopback, a fake clock, a fake code host, a vault in memory, and `git` with no
 * configuration of the person (an empty file, a temporary HOME, an identity given with `-c`).
 *
 * The fakes of `@otheater/core/testing` can only be imported by a `*.test.ts(x)`, so the test
 * builds them and passes them in.
 */

/** The compiled fake agent: `pnpm build` comes first. */
export const FAKE_AGENT_CLI = fileURLToPath(
  new URL('../../../fake-agent/dist/cli.js', import.meta.url),
);

/** True where this platform has no process launcher yet (Windows, N94 and N58). */
export const NO_LAUNCHER = defaultLauncher() === undefined;

export function assertFakeAgentBuilt(): void {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
}

export interface FakeCodeHostLike extends CodeHost {
  adoptLocal(repo: string, branch: string, sha: string): void;
  seedRemote(repo: string, branch: string): string;
  pullRequests(): readonly PullRequest[];
}

export interface ChatFakes {
  readonly codeHost: FakeCodeHostLike;
  readonly clock: Clock;
  readonly vault: SecretVault;
  /** The fake client adapter that runs the command it is given, with `env` in its processes. */
  readonly client: (
    launcher: ProcessLauncher,
    command: { readonly cmd: string; readonly args: readonly string[] },
    env: Readonly<Record<string, string>>,
  ) => ClientAdapter | readonly ClientAdapter[];
}

const run = promisify(execFile);

/** What `git` is run with here: nothing of the person's configuration reaches it. */
function gitEnv(home: string, config: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** A code host in memory whose pushes are the real heads of the repository. */
class RealHeadCodeHost implements CodeHost {
  readonly id: string;
  readonly implements: AdapterImplements;
  readonly #fake: FakeCodeHostLike;
  readonly #git: (cwd: string, ...args: string[]) => Promise<string>;

  constructor(fake: FakeCodeHostLike, git: (cwd: string, ...args: string[]) => Promise<string>) {
    this.#fake = fake;
    this.#git = git;
    this.id = (fake as Adapter).id;
    this.implements = (fake as Adapter).implements;
  }

  async pushRef(target: BranchTarget): Promise<string> {
    const head = await this.#git(target.repo, 'rev-parse', `refs/heads/${target.branch}`);
    this.#fake.adoptLocal(target.repo, target.branch, head.trim());
    return this.#fake.pushRef(target);
  }

  remoteRef(target: BranchTarget): Promise<string | undefined> {
    return this.#fake.remoteRef(target);
  }

  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    return this.#fake.openPullRequest(opts);
  }

  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    return this.#fake.findPullRequest(opts);
  }

  mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    return this.#fake.mergeBranch(opts);
  }

  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    return this.#fake.isBranchMerged(opts);
  }
}

export interface ChatDaemon {
  readonly daemon: DaemonHandle;
  readonly codeHost: FakeCodeHostLike;
  readonly dataDir: string;
  /** What the TUI connects through: discovery in `dataDir`. */
  readonly connector: DaemonConnector;
  /** The scenario of the repository, the one the TUI opens on. */
  readonly scenarioId: string;
  /** The plays of the scenario, newest last. */
  plays(): Promise<readonly PlayRecord[]>;
  /** Every event of the log, in order. */
  events(): Promise<readonly EventEnvelope[]>;
}

export interface ChatDaemonOptions {
  /** Extra top-level YAML (the timers of `api.chat`, limits...). */
  readonly extra?: string;
}

/** Polls `read` until it returns something, or fails after `timeoutMs` of real time. */
export async function waitUntil<T>(
  what: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The daemon with the fake agent as every role (`role-play`), the fake code host and a real
 * repository with a bare `origin`, all in temporary folders, and one scenario for that repository.
 * The clock is frozen, so no timer of the daemon fires: the play moves by what the roles do. The
 * timers of the chat socket run on real time and are short (`api.chat`).
 */
export async function withChatDaemon(
  fakes: ChatFakes,
  options: ChatDaemonOptions,
  body: (chat: ChatDaemon) => Promise<void>,
): Promise<void> {
  assertFakeAgentBuilt();
  const launcher = defaultLauncher();
  if (launcher === undefined) throw new Error('this platform has no process launcher');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-tui-chat-')));
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'agent-state');
  const home = join(root, 'home');
  const gitConfig = join(root, 'gitconfig');
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await run(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd, env: gitEnv(home, gitConfig) },
    );
    return stdout;
  };
  await mkdir(dataDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(gitConfig, '');
  await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--quiet', '--initial-branch=main', repo);
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '--quiet', '-m', 'initial commit');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '--quiet', 'origin', 'main');

  const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  submit_retries: 1
project:
  conventions: detect
orchestration:
  executor:
    client: fake
    profile: one
    model: fake-model
api:
  chat:
    resume_window: 50ms
    heartbeat: 30s
    state_interval: 100ms
    close_grace: 200ms
${options.extra ?? ''}
`);
  const realHead = new RealHeadCodeHost(fakes.codeHost, git);
  const noClients = { env: { PATH: '' }, findExecutable: () => undefined };
  const daemon = await startDaemon({
    dataDir,
    config,
    overrides: { clock: fakes.clock, vault: fakes.vault, launcher, codeHost: realHead },
    clients: (parts) => [
      ...productionClients(config, noClients)(parts),
      ...[
        fakes.client(
          parts.launcher,
          { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
          { FAKE_AGENT_SCRIPT: 'role-play', FAKE_AGENT_STATE_DIR: stateDir },
        ),
      ].flat(),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  try {
    fakes.codeHost.seedRemote(repo, 'main');
    const { producer } = daemon;
    if (producer === undefined) throw new Error('the daemon has no Producer channel');
    const { scenarioId } = await producer.openChat({ repo });
    await body({
      daemon,
      codeHost: fakes.codeHost,
      dataDir,
      connector: directoryConnector(createNodeDaemonDirectory({ dataDir })),
      scenarioId,
      plays: () => daemon.store.plays.list({ scenarioId }),
      events: () => daemon.store.events.readFrom(0, 100_000),
    });
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
