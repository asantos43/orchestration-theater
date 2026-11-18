// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import type { EventLog, ExecutorConfig, Profile, RolePolicy } from '@otheater/core';
import type { AttemptOutcome, AttemptSpec } from '../execution/attempt-runner.js';

/**
 * The short test session of the cadastro of an Executor (architecture 5.7, step 4): one attempt
 * with the model, in a scratch repository, asked to call the framework tool `submit` once. The
 * Executor passes when the attempt ends well AND the daemon recorded the `submit` call
 * (`attempt.submitted`): that proves in one go that the session starts, the model answers, calls a
 * tool of the framework MCP server and ends. It spends tokens, so `executors.test_session` is `off`
 * by default.
 */

export interface TestSessionRequest {
  readonly profile: Profile;
  /** The model id as the client's catalog lists it. */
  readonly model: string;
  readonly effort: string | null;
  readonly executorId: string;
}

export interface TestSessionResult {
  readonly ok: boolean;
  /** One line for the Producer: what passed or why it failed. */
  readonly detail: string;
}

export interface TestSession {
  run(request: TestSessionRequest): Promise<TestSessionResult>;
}

/** What the session needs from the execution: the attempt runner of the daemon, narrowed. */
export interface AttemptRunnerLike {
  run(spec: AttemptSpec): Promise<AttemptOutcome>;
}

export interface ScratchRepo {
  /** The main checkout the attempt worktree is cut from. */
  readonly repo: string;
  /** Ref the attempt branch starts at. */
  readonly base: string;
  dispose(): Promise<void>;
}

export interface AttemptTestSessionOptions {
  readonly runner: AttemptRunnerLike;
  readonly events: EventLog;
  /** A throwaway repository with one commit; the session never touches the Producer's repositories. */
  readonly scratch: () => Promise<ScratchRepo>;
  /** What the role of the session may do: read-only, the framework server and its tools. */
  readonly policy: RolePolicy;
  /** The role the session plays (decides the framework tools it is handed). Default `author`. */
  readonly role?: string;
  /** Default {@link DEFAULT_TEST_PROMPT}. Tests with the fake agent give a script here. */
  readonly prompt?: string;
  /** Default 120 s [proposta]. Never above `limits.demand_timeout_max`. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TEST_PROMPT =
  'This is a short capability test of the model, not a task. Do not read or change any file. ' +
  'Call the tool `submit` once with {"result": {"ok": true}} and then stop.';

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/** Runs the test session as an attempt of the daemon. */
export function attemptTestSession(options: AttemptTestSessionOptions): TestSession {
  return {
    async run(request) {
      const scratch = await options.scratch();
      try {
        const since = await options.events.lastId();
        const executor: ExecutorConfig = {
          model: request.model,
          ...(request.effort === null ? {} : { effort: request.effort }),
        };
        const outcome = await options.runner.run({
          playId: 'executor-test',
          demandId: `t${randomBytes(4).toString('hex')}`,
          attempt: 1,
          repo: scratch.repo,
          base: scratch.base,
          profile: request.profile,
          executor,
          policy: options.policy,
          prompt: options.prompt ?? DEFAULT_TEST_PROMPT,
          role: options.role ?? 'author',
          timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
        });
        if (outcome.state !== 'completed') {
          return {
            ok: false,
            detail: `the session ended ${outcome.state}${outcome.cause === undefined ? '' : `: ${outcome.cause}`}`,
          };
        }
        const events = await options.events.readFrom(since, 10_000);
        const called = events.some(
          (event) =>
            event.attemptId === outcome.attemptId &&
            event.type === 'attempt.submitted' &&
            (event.payload as { tool?: unknown }).tool === 'submit',
        );
        return called
          ? { ok: true, detail: 'the model started a session, called the tool "submit" and ended' }
          : { ok: false, detail: 'the session ended but the model did not call the tool "submit"' };
      } finally {
        await scratch.dispose().catch(() => undefined);
      }
    },
  };
}
