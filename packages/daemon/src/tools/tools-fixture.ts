// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the work tools only (excluded from the build of the package).
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attemptBranch,
  playBranch,
  type JsonObject,
  type Clock,
  type NewEvent,
  type ProcessLauncher,
  type Store,
  type Vcs,
} from '@otheater/core';
import { testGit } from '@otheater/sdk';
import { defaultLauncher, defaultVcs } from '../compose.js';
import { parseConfig, type ToolsConfig } from '../config.js';
import { ToolFailure, type ToolCall, type ToolCaller, type ToolHandler } from '../mcp/handlers.js';
import { buildDaemonRegistries } from '../registries.js';
import { makeRepo } from '../execution/attempt-fixture.js';
import { nodePathHost, workToolHandlers, type ToolsDeps } from './index.js';

const registries = buildDaemonRegistries();

export const PLAY_ID = 'p1';
export const DEMAND_ID = 'd1';
export const ATTEMPT_ID = 'p1/d1/1';
export const SCENARIO_ID = 's1';

export interface ToolsRigOptions {
  /** The `tools:` block of the config, as YAML lines under `tools:` (indent two spaces). */
  readonly tools?: string;
  /** `configOverride` of the scenario of the play. */
  readonly configOverride?: JsonObject;
  /** `conventions` of the scenario of the play. */
  readonly conventions?: JsonObject | null;
  /** The domains of the role (`network.allow`). */
  readonly networkAllow?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly launcher?: ProcessLauncher | undefined;
  readonly vcs?: Vcs;
  /** Leaves the attempt out of the store (a session that is tied to nothing). */
  readonly withoutAttempt?: boolean;
}

export interface ToolsRig {
  readonly repo: string;
  readonly worktree: string;
  readonly branch: string;
  readonly store: Store;
  readonly deps: ToolsDeps;
  readonly config: ToolsConfig;
  /** Every event the tools recorded, in order. */
  readonly events: NewEvent[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
  /** Validates the input as the server does, runs the handler, resolves with its reply. */
  call(name: string, input: unknown, caller?: Partial<ToolCaller>): Promise<unknown>;
  /** Like `call`, but resolves with the failure the tool answered instead of rejecting. */
  fail(name: string, input: unknown, caller?: Partial<ToolCaller>): Promise<ToolFailure>;
  write(name: string, content: string): Promise<void>;
  dispose(): Promise<void>;
}

export function eventsOf(rig: Pick<ToolsRig, 'events'>, type: string): NewEvent[] {
  return rig.events.filter((event) => event.type === type);
}

/** The real time: the tools measure durations and the timeouts are real. */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      // As SystemClock does: an abort rejects.
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('sleep cancelled'));
      });
    }),
};

/**
 * What the tests hand to the rig: this file is no test, so the fakes of `@otheater/core/testing`
 * and the adapters come from the test file (rules testing-only-from-tests and
 * daemon-adapters-only-in-compose).
 */
export interface ToolsRigParts {
  readonly store: Store;
  readonly clock: Clock;
}

/**
 * A real git repository with the branch of the play and a real worktree of one attempt, the real
 * process launcher and the real clock, over an in-memory store with the scenario, the play and
 * the attempt written down. The tools run exactly as the daemon registers them.
 */
export async function makeToolsRig(
  options: ToolsRigOptions,
  parts: ToolsRigParts,
): Promise<ToolsRig> {
  const { repo, dispose: disposeRepo } = await makeRepo();
  const vcs = options.vcs ?? defaultVcs();
  await testGit(repo, 'branch', playBranch(PLAY_ID), 'main');
  const worktreeRoot = await realpath(await mkdtemp(join(tmpdir(), 'otheater-tools-wt-')));
  const worktree = join(worktreeRoot, 'attempt');
  const branch = attemptBranch(PLAY_ID, DEMAND_ID, 1);
  await vcs.createWorktree({ repo, path: worktree, branch, base: playBranch(PLAY_ID) });

  const { clock, store } = parts;
  await store.scenarios.create({
    id: SCENARIO_ID,
    kind: 'project',
    flowId: 'play.default',
    name: 'tools',
    folder: repo,
    baseBranch: 'main',
    configOverride: options.configOverride ?? {},
    conventions: options.conventions ?? null,
  });
  await store.plays.create({
    id: PLAY_ID,
    scenarioId: SCENARIO_ID,
    need: 'need',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
  if (options.withoutAttempt !== true) {
    await store.attempts.put({
      attemptId: ATTEMPT_ID,
      playId: PLAY_ID,
      demandId: DEMAND_ID,
      attempt: 1,
      client: 'fake',
      profile: 'one',
      state: 'executing',
      cause: null,
      sessionId: null,
      worktree,
      branch,
      lastCheckpoint: null,
      lastCheckpointAt: null,
      lastEventAt: null,
      resumes: 0,
      freeResumes: 0,
    });
  }

  const config = parseConfig(options.tools === undefined ? '' : `tools:\n${options.tools}\n`).tools;
  const launcher = 'launcher' in options ? options.launcher : defaultLauncher();
  const deps: ToolsDeps = {
    store,
    config,
    launcher,
    vcs,
    clock,
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
    host: nodePathHost(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const handlers = workToolHandlers(deps);
  const events: NewEvent[] = [];

  function callOf(name: string, input: unknown, caller: Partial<ToolCaller>): ToolCall {
    const tool = registries.tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return {
      tool,
      input: tool.input.parse(input),
      caller: {
        role: 'actor',
        attemptId: ATTEMPT_ID,
        sessionId: undefined,
        correlation: { playId: PLAY_ID, demandId: DEMAND_ID, attemptId: ATTEMPT_ID },
        worktree,
        networkAllow: options.networkAllow ?? [],
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
        ...caller,
      },
    };
  }

  async function call(
    name: string,
    input: unknown,
    caller: Partial<ToolCaller> = {},
  ): Promise<unknown> {
    const handler = handlers[name];
    if (handler === undefined) throw new Error(`no handler ${name}`);
    return await handler(callOf(name, input, caller));
  }

  return {
    repo,
    worktree,
    branch,
    store,
    deps,
    config,
    events,
    handlers,
    call,
    async fail(name, input, caller) {
      try {
        await call(name, input, caller);
      } catch (error) {
        if (error instanceof ToolFailure) return error;
        throw error;
      }
      throw new Error(`${name} did not fail`);
    },
    async write(name, content) {
      await writeFile(join(worktree, name), content);
    },
    async dispose() {
      await disposeRepo();
      await rm(worktreeRoot, { recursive: true, force: true });
    },
  };
}
