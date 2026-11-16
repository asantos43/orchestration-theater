// SPDX-License-Identifier: MPL-2.0
import type { SharedCancelMode } from '@otheater/core';
import type { DaemonConfig } from '../config.js';

/** Pool constants (architecture 5.2). */
export interface PoolSettings {
  /** `K`: sessions per adapter process, for clients that share one. */
  readonly sessionsPerProcess: number;
  /** Sessions admitted at once (the admission semaphore counts sessions, not processes). */
  readonly maxSessions: number;
  /** A process with no session for this long is closed (`idleMs`). */
  readonly idleMs: number;
  /** `pool.shared_cancel`: what a cancel does to a process shared by several sessions. */
  readonly sharedCancel: SharedCancelMode;
}

/** Everything the execution of attempts reads from the configuration, in milliseconds. */
export interface ExecutionSettings {
  readonly pool: PoolSettings;
  /** `limits.demand_timeout`, used when the request names none. */
  readonly timeoutMs: number;
  /** `limits.demand_timeout_max`: a request never gets more than this. */
  readonly timeoutMaxMs: number;
  /** `resume.checkpoint_every`. */
  readonly checkpointEveryMs: number;
  /** Completed edit tool calls that make one batch. */
  readonly checkpointEditBatch: number;
  /** `resume.max_resumes`. */
  readonly maxResumes: number;
  /** `resume.max_free_resumes`: resumes after another session's cancel that cost no `maxResumes`. */
  readonly maxFreeResumes: number;
  /** `resume.transient_backoff`: the wait before each native resume after a transient error. */
  readonly transientBackoffMs: readonly number[];
  /** `resume.stuck.no_event_for`. */
  readonly stuckNoEventMs: number;
  /** `resume.stuck.same_error_times`. */
  readonly stuckSameErrorTimes: number;
  /** What the Executor is told when a conversation is reloaded. */
  readonly continuePrompt: string;
}

/** The execution constants of a validated configuration. */
export function executionSettingsOf(config: DaemonConfig): ExecutionSettings {
  return {
    pool: {
      sessionsPerProcess: config.pool.sessions_per_process,
      maxSessions: config.pool.max_sessions,
      idleMs: config.pool.idle,
      sharedCancel: config.pool.shared_cancel,
    },
    timeoutMs: config.limits.demand_timeout,
    timeoutMaxMs: config.limits.demand_timeout_max,
    checkpointEveryMs: config.resume.checkpoint_every,
    checkpointEditBatch: config.resume.checkpoint_edit_batch,
    maxResumes: config.resume.max_resumes,
    maxFreeResumes: config.resume.max_free_resumes,
    transientBackoffMs: config.resume.transient_backoff,
    stuckNoEventMs: config.resume.stuck.no_event_for,
    stuckSameErrorTimes: config.resume.stuck.same_error_times,
    continuePrompt: config.resume.continue_prompt,
  };
}
