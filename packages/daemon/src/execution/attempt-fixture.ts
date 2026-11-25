// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the execution of attempts only (excluded from the build of the package).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ClientAdapter,
  Clock,
  EventEnvelope,
  ProcessLauncher,
  SessionTransport,
  Store,
} from '@otheater/core';
import { testGit } from '@otheater/sdk';
import pino from 'pino';
import { defaultVcs } from '../compose.js';
import { editingTransport, TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import type { McpAccess } from '../mcp/access.js';
import { AttemptRunner, type AttemptRunnerOptions, type AttemptSpec } from './attempt-runner.js';
import type { ExhaustionPort } from './exhaustion.js';
import type { HandoffPort } from './handoff.js';
import { SessionPool } from './pool.js';
import { DEFAULT_PACKAGE_SETTINGS, type ExecutionSettings } from './settings.js';

export const HOUR = 3_600_000;

/** Settings with nothing firing by itself; a test turns on what it exercises. */
export const QUIET_SETTINGS: ExecutionSettings = {
  pool: { sessionsPerProcess: 2, maxSessions: 10, idleMs: HOUR, sharedCancel: 'escalate' },
  timeoutMs: HOUR,
  timeoutMaxMs: 24 * HOUR,
  turnTimeoutMs: HOUR,
  onTurnTimeout: 'off',
  checkpointEveryMs: 0,
  checkpointEditBatch: 0,
  maxResumes: 3,
  maxFreeResumes: 3,
  transientBackoffMs: [0],
  stuckNoEventMs: 0,
  stuckSameErrorTimes: 99,
  quotaWaitMaxMs: 30 * 60_000,
  transientExhausted: 'last',
  clientCrashCounts: 'repeat',
  quotaWaitGraceMs: 60_000,
  quotaWaitDeadline: 'pause',
  quotaWaitCounts: 'resume',
  quotaWaitMissed: 'handoff',
  onProfileRemoved: 'handoff',
  onRestart: 'native',
  whenUnstarted: 'prompt',
  continuePrompt: 'carry on',
  package: DEFAULT_PACKAGE_SETTINGS,
  terminalOutput: { mode: 'truncated', maxBytes: 64 * 1024 },
};

/** A real git repository with one commit, in a temporary directory. */
export async function makeRepo(): Promise<{ repo: string; dispose: () => Promise<void> }> {
  const repo = await mkdtemp(join(tmpdir(), 'otheater-attempt-repo-'));
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
  return { repo, dispose: () => rm(repo, { recursive: true, force: true }) };
}

/** What a test hands in: the fakes it also inspects (the fixture cannot import them itself). */
export interface RigParts {
  readonly clock: Clock;
  readonly store: Store;
  readonly launcher: ProcessLauncher;
  readonly transport: SessionTransport;
  readonly adapter: ClientAdapter;
}

export interface RigCore {
  readonly repo: string;
  readonly pool: SessionPool;
  readonly runner: AttemptRunner;
  readonly settings: ExecutionSettings;
  readonly worktreeRoot: string;
  dispose(): Promise<void>;
}

export type Rig<P extends RigParts> = P & RigCore;

/** The runner on the fakes of the test and the real `GitVcs` on a real temporary repo. */
export async function makeRig<P extends RigParts>(
  parts: P,
  overrides: Partial<ExecutionSettings> = {},
  mcp?: McpAccess,
  quota?: AttemptRunnerOptions['quota'],
  handoff?: HandoffPort,
  exhaustion?: ExhaustionPort,
): Promise<Rig<P>> {
  const { repo, dispose: disposeRepo } = await makeRepo();
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'otheater-attempt-wt-'));
  const settings = { ...QUIET_SETTINGS, ...overrides };
  const editing = editingTransport(parts.transport);
  const pool = new SessionPool({
    clients: [parts.adapter],
    launcher: parts.launcher,
    transport: () => editing,
    clock: parts.clock,
    settings: settings.pool,
  });
  const runner = new AttemptRunner({
    store: parts.store,
    vcs: defaultVcs(),
    pool,
    clock: parts.clock,
    settings,
    worktreeRoot,
    logger: pino({ level: 'silent' }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(quota === undefined ? {} : { quota }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(exhaustion === undefined ? {} : { exhaustion }),
  });
  return {
    ...parts,
    repo,
    pool,
    runner,
    settings,
    worktreeRoot,
    dispose: async () => {
      await pool.shutdown();
      await disposeRepo();
      await rm(worktreeRoot, { recursive: true, force: true });
    },
  };
}

export function specOf(
  rig: RigCore,
  prompt: string,
  extra: Partial<AttemptSpec> = {},
): AttemptSpec {
  return {
    playId: 'play-1',
    demandId: 'demand-1',
    attempt: 1,
    repo: rig.repo,
    base: 'main',
    profile: TEST_PROFILE,
    executor: { model: 'fake-model' },
    policy: TEST_POLICY,
    prompt,
    ...extra,
  };
}

export async function eventsOf(
  rig: { store: Store },
  type?: string,
): Promise<readonly EventEnvelope[]> {
  const all = await rig.store.events.readFrom(0, 10_000);
  return type === undefined ? all : all.filter((event) => event.type === type);
}

/** Polls (in real time, git is real) until `check` holds. */
export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
