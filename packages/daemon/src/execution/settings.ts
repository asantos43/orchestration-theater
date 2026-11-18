// SPDX-License-Identifier: MPL-2.0
import type { SharedCancelMode } from '@otheater/core';
import {
  type DaemonConfig,
  type PACKAGE_DIFF_MODES,
  type QUOTA_WAIT_COUNTS_MODES,
  type QUOTA_WAIT_DEADLINE_MODES,
  type QUOTA_WAIT_MISSED_MODES,
  type PACKAGE_SHORT_OUTPUT_MODES,
  type PACKAGE_SUMMARIZE_MODES,
  CLIENT_IDS,
  sessionMbOf,
  sessionsPerProcessOf,
} from '../config.js';
import type { ClientCrashCounts, TransientExhausted } from './interruption-policy.js';
import type { AdmissionSettings, SessionMb } from './admission.js';

/** Pool constants (architecture 5.2). */
export interface PoolSettings {
  /** `K`: sessions per adapter process, for clients that share one. The value of a client with none of its own. */
  readonly sessionsPerProcess: number;
  /**
   * The effective `K` by adapter id (`pool.<client>.sessions_per_process`, or else the global
   * one). A client missing here uses `sessionsPerProcess`; read it through
   * {@link sessionsPerProcessFor}.
   */
  readonly sessionsPerProcessByClient?: Readonly<Record<string, number>>;
  /** Sessions admitted at once (the admission semaphore counts sessions, not processes). */
  readonly maxSessions: number;
  /** A process with no session for this long is closed (`idleMs`). */
  readonly idleMs: number;
  /** `pool.shared_cancel`: what a cancel does to a process shared by several sessions. */
  readonly sharedCancel: SharedCancelMode;
  /** `pool.admission`; absent: `slots` (the behaviour from before P4). */
  readonly admission?: AdmissionSettings;
  /** `pool.<client>.session_mb` by adapter id; absent: the measured default of the client. */
  readonly sessionMbByClient?: Readonly<Record<string, SessionMb>>;
  /**
   * Ids of the profiles in the Director's list, for `reserve_when: listed` on a local instance.
   * [N] The daemon has no such list yet; the profiles of the Director are not wired here.
   */
  readonly directorProfiles?: readonly string[];
}

/** `K` of one client: its own value, or else the global one. */
export function sessionsPerProcessFor(settings: PoolSettings, client: string): number {
  return settings.sessionsPerProcessByClient?.[client] ?? settings.sessionsPerProcess;
}

/** `resume.package.*` (architecture 5.16, Phase 5, P18): the continuation package of a handoff. */
export interface PackageSettings {
  readonly summarize: (typeof PACKAGE_SUMMARIZE_MODES)[number];
  readonly maxChars: number;
  readonly diff: (typeof PACKAGE_DIFF_MODES)[number];
  readonly diffMaxChars: number;
  readonly shortOutputRoles: readonly string[];
  readonly shortOutput: (typeof PACKAGE_SHORT_OUTPUT_MODES)[number];
}

/** The defaults of `resume.package.*` (the configuration has the same ones). */
export const DEFAULT_PACKAGE_SETTINGS: PackageSettings = {
  summarize: 'deterministic',
  maxChars: 48_000,
  diff: 'stat',
  diffMaxChars: 12_000,
  shortOutputRoles: ['reviewer', 'scriptwriter', 'critic'],
  shortOutput: 'redo',
};

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
  /** `resume.quota_wait_max`: a reset nearer than this, with the rule `wait`, is waited for. */
  readonly quotaWaitMaxMs: number;
  /** `resume.transient_exhausted` [proposta]. */
  readonly transientExhausted: TransientExhausted;
  /** `resume.client_crash_counts` [proposta]. */
  readonly clientCrashCounts: ClientCrashCounts;
  /** `resume.quota_wait_grace` [proposta] (P19): how long past the reset the wait trusts the hook. */
  readonly quotaWaitGraceMs: number;
  /** `resume.quota_wait_deadline` [proposta] (P19). */
  readonly quotaWaitDeadline: (typeof QUOTA_WAIT_DEADLINE_MODES)[number];
  /** `resume.quota_wait_counts` [proposta] (P19). */
  readonly quotaWaitCounts: (typeof QUOTA_WAIT_COUNTS_MODES)[number];
  /** `resume.quota_wait_missed` [proposta] (P19). */
  readonly quotaWaitMissed: (typeof QUOTA_WAIT_MISSED_MODES)[number];
  /** What the Executor is told when a conversation is reloaded. */
  readonly continuePrompt: string;
  /** `resume.package.*`. */
  readonly package: PackageSettings;
}

/** The execution constants of a validated configuration. */
export function executionSettingsOf(config: DaemonConfig): ExecutionSettings {
  return {
    pool: {
      sessionsPerProcess: config.pool.sessions_per_process,
      sessionsPerProcessByClient: Object.fromEntries(
        CLIENT_IDS.map((client) => [client, sessionsPerProcessOf(config.pool, client)]),
      ),
      maxSessions: config.pool.max_sessions,
      idleMs: config.pool.idle,
      sharedCancel: config.pool.shared_cancel,
      admission: {
        mode: config.pool.admission.mode,
        minFreeMb: config.pool.admission.min_free_mb,
        recheckMs: config.pool.admission.recheck,
        unknownRam: config.pool.admission.unknown_ram,
      },
      sessionMbByClient: Object.fromEntries(
        CLIENT_IDS.map((client) => [client, sessionMbOf(config.pool, client)]),
      ),
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
    quotaWaitMaxMs: config.resume.quota_wait_max,
    transientExhausted: config.resume.transient_exhausted,
    clientCrashCounts: config.resume.client_crash_counts,
    quotaWaitGraceMs: config.resume.quota_wait_grace,
    quotaWaitDeadline: config.resume.quota_wait_deadline,
    quotaWaitCounts: config.resume.quota_wait_counts,
    quotaWaitMissed: config.resume.quota_wait_missed,
    continuePrompt: config.resume.continue_prompt,
    package: {
      summarize: config.resume.package.summarize,
      maxChars: config.resume.package.max_chars,
      diff: config.resume.package.diff,
      diffMaxChars: config.resume.package.diff_max_chars,
      shortOutputRoles: config.resume.package.short_output_roles,
      shortOutput: config.resume.package.short_output,
    },
  };
}
