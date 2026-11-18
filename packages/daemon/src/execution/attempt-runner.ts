// SPDX-License-Identifier: MPL-2.0
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  attemptBranch,
  attemptInputOf,
  Cancelled,
  formatExecutorId,
  hasErrorCode,
  mcpToolsOf,
  type AttemptRecord,
  type AttemptRecordInput,
  type Clock,
  type ExecutorConfig,
  type NormalizedUpdate,
  type PermissionOutcome,
  type Profile,
  type RolePolicy,
  type StopReason,
  type Store,
  type Vcs,
  type WhenExhausted,
} from '@otheater/core';
import { buildDaemonEvent, type ExecutorPayload, type InterruptionCause } from '@otheater/protocol';
import { FRAMEWORK_MCP_NAME, type McpAccess, type McpGrant } from '../mcp/access.js';
import { CheckpointTracker } from './checkpoints.js';
import { AttemptJournal, type AttemptPatch } from './journal.js';
import {
  decideInterruption,
  type InFlightMode,
  type InterruptionDecision,
  type InterruptionFacts,
  type InterruptionRules,
} from './interruption-policy.js';
import { permissionEventsOf, resolveExistingPath } from './permission-log.js';
import type { SessionLease, SessionPool } from './pool.js';
import type { ExecutionSettings } from './settings.js';
import type { Logger } from '../logger.js';
import { limitHitOf, type LimitHit, type QuotaService } from '../quota/service.js';

/** What an attempt needs to run (the Director fills it in from the demand and the role). */
export interface AttemptSpec {
  readonly playId: string;
  readonly demandId: string;
  /** Number of this attempt of the demand, from 1. */
  readonly attempt: number;
  /** The main checkout of the repository the worktree is cut from. */
  readonly repo: string;
  /** Ref the attempt branch starts at (the base of the play). */
  readonly base: string;
  readonly profile: Profile;
  readonly executor: ExecutorConfig;
  readonly policy: RolePolicy;
  readonly prompt: string;
  /**
   * The role the Executor plays (`author`, `reviewer`...). It decides the tools the framework MCP
   * server lists for the session. Without it the session gets no framework tools.
   */
  readonly role?: string;
  /** Overrides `limits.demand_timeout`; never above `limits.demand_timeout_max`. */
  readonly timeoutMs?: number;
  /** `roles.<role>.when_exhausted` (5.7): `wait` waits for a near reset, `next` (default) hands off. */
  readonly whenExhausted?: WhenExhausted;
  /** `profiles.<id>.budget.in_flight` (5.6); default `handoff`. Read by the policy of 5.16. */
  readonly inFlight?: InFlightMode;
}

/** What the daemon must know again to resume an attempt it did not start (reconciliation). */
export interface ResumeContext {
  /** The role again, for the framework tools of the resumed session (see `AttemptSpec.role`). */
  readonly role?: string;
  readonly profile: Profile;
  readonly executor: ExecutorConfig;
  readonly policy: RolePolicy;
  readonly timeoutMs?: number;
  readonly whenExhausted?: WhenExhausted;
  readonly inFlight?: InFlightMode;
}

export const ATTEMPT_RESULT_STATES = ['completed', 'failed', 'timed_out', 'interrupted'] as const;
export type AttemptResultState = (typeof ATTEMPT_RESULT_STATES)[number];

/** How an attempt ended for the caller. */
export interface AttemptOutcome {
  readonly attemptId: string;
  readonly state: AttemptResultState;
  /** An interruption cause, or the text of a failure. */
  readonly cause: string | undefined;
  readonly stopReason: StopReason | undefined;
  readonly sessionId: string | undefined;
  /** Last checkpoint commit on the attempt branch. */
  readonly checkpointSha: string | undefined;
  readonly branch: string;
  readonly worktree: string;
  /** Native resumes made. */
  readonly resumes: number;
  /**
   * The attempt stopped and only a decision continues it (architecture 5.16, "Política por
   * causa"): the Director hands it off to another Executor, waits for the quota or gives up.
   */
  readonly needsDecision: boolean;
  /**
   * What the policy of 5.16 decided for the last interruption of the attempt, when it was
   * interrupted. A `handoff` (P18) or `wait_for_reset` (P19) action is not carried out here yet:
   * the attempt is parked and the caller reads the action.
   */
  readonly decision: InterruptionDecision | undefined;
  /** The end consumes an attempt of the demand: a failure of the agent, not a cause outside it. */
  readonly countsAsAttempt: boolean;
}

/** How an attempt id is built from its parts. */
export function attemptIdOf(playId: string, demandId: string, attempt: number): string {
  return `${playId}/${demandId}/${String(attempt)}`;
}

export interface AttemptRunnerOptions {
  readonly store: Store;
  readonly vcs: Vcs;
  readonly pool: SessionPool;
  readonly clock: Clock;
  readonly settings: ExecutionSettings;
  /** Directory the worktrees of the attempts go under (`<root>/<play>/<demand>-<n>`). */
  readonly worktreeRoot: string;
  readonly logger: Logger;
  /**
   * The framework MCP server (5.3). When set, an attempt with a `role` whose policy lists
   * `otheater` gets its URL and a token of its own in the MCP servers of the session.
   */
  readonly mcp?: McpAccess;
  /**
   * The quota of the profiles (P5). A limit error of a session goes to it, and it says when the
   * quota comes back; without it the reset time of an exhausted quota is unknown.
   */
  readonly quota?: Pick<QuotaService, 'ingestLimitHit'>;
}

/** What one go at a session came to. */
type Ended =
  | { readonly kind: 'finished'; readonly stopReason: StopReason }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'interrupted';
      readonly cause: InterruptionCause;
      readonly detail: string;
      /** The conversation can be reloaded (`session/load`); otherwise it needs a decision. */
      readonly native: boolean;
      /** The adapter process is gone or useless and must be ended. */
      readonly kill: boolean;
      /**
       * The loss was no failure of the client: the cancel of another session ended the shared
       * process (`pool.shared_cancel`). The resume that follows does not use `resume.max_resumes`,
       * until the attempt has had `resume.max_free_resumes` of them; after that it counts.
       */
      readonly free?: boolean;
      /** What the classification saw: names of signals, never a credential or a prompt. */
      readonly signals: readonly string[];
      /** The limit error behind a `quota_exhausted`, for the `QuotaService`. */
      readonly limitHit?: LimitHit;
      readonly sha: string | undefined;
    }
  | { readonly kind: 'timeout'; readonly sha: string | undefined }
  | { readonly kind: 'stopped'; readonly sha: string | undefined };

type Raced = Ended | { readonly kind: 'error'; readonly error: unknown };

/** The next session to open: new, or the reload of an earlier one. */
interface Step {
  readonly resumeSessionId: string | undefined;
  readonly prompt: string;
  /** Why the conversation is being reloaded. */
  readonly cause: InterruptionCause | undefined;
}

interface PendingUpdate {
  readonly sessionId: string;
  readonly update: NormalizedUpdate;
}

interface AttemptContext {
  readonly attemptId: string;
  readonly spec: ResumeContext & {
    readonly playId: string;
    readonly demandId: string;
    readonly attempt: number;
  };
  readonly branch: string;
  readonly worktree: string;
  readonly journal: AttemptJournal;
  readonly tracker: CheckpointTracker;
  readonly stop: AbortController;
  readonly deadline: number;
  readonly firstPrompt: string;
  sessionId: string | undefined;
  /** `session.opened` was recorded and `session.closed` was not yet. */
  sessionOpen: boolean;
  lease: SessionLease | undefined;
  /**
   * Updates of the current session that arrived before its `session.opened` was recorded, in
   * arrival order. `undefined` when no session is waiting to be opened (none is running, or its
   * `session.opened` is already in the log). It belongs to one go (`#once`), not to the attempt.
   */
  pending: PendingUpdate[] | undefined;
  lastEventAt: number;
  lastError: { key: string; count: number } | undefined;
  /** Drops of the client process of this attempt that cost no free allowance (`client_crash`). */
  crashes: number;
}

const NEVER: Promise<never> = new Promise<never>(() => undefined);

/** Signal of the `interruptions` row of a drop that cost no resume (`resume.max_free_resumes`). */
const FREE_SIGNAL = 'free_resume';

/**
 * Runs attempts (architecture 5.16): one attempt is one worktree and one branch, a session of an
 * Executor and everything around it that makes the work survive an interruption.
 *
 * - The worktree and the branch come from the `Vcs` port; the registry record and every event are
 *   written together (`AttemptJournal`).
 * - The stream of `session.update` goes to the `EventLog` as events.
 * - The deadline (`limits.demand_timeout`) ends the attempt in this order: WIP commit on the
 *   attempt branch, `session/cancel`, kill of the process tree. Nothing is left running.
 * - Checkpoints (`CheckpointTracker`): per batch of edits, per interval and on every
 *   interruption.
 * - What to do about an interruption is `decideInterruption` (the table of 5.16, a pure function);
 *   each one also leaves a row in `interruptions` with the cause, the signals and the form. A
 *   crash of the client, a transient error or a restart of the daemon resume the same
 *   conversation (`session/load`), with the backoff the policy chose and `resume.max_resumes` as
 *   the limit. The other actions (handoff, wait for the reset, the cap's `finish` and `stop`, the
 *   Director's judgment) park the attempt as `interrupted` with `needsDecision`, and the outcome
 *   carries the action: the handoff is P18's and the wait is P19's.
 */
export class AttemptRunner {
  readonly #options: AttemptRunnerOptions;
  readonly #running = new Map<string, { context: AttemptContext; done: Promise<unknown> }>();
  #stopping = false;

  constructor(options: AttemptRunnerOptions) {
    this.#options = options;
  }

  /** Attempts in progress. */
  get active(): number {
    return this.#running.size;
  }

  /** Creates the worktree and the branch of the attempt and runs it to its end. */
  async run(spec: AttemptSpec): Promise<AttemptOutcome> {
    this.#assertOpen();
    const attemptId = attemptIdOf(spec.playId, spec.demandId, spec.attempt);
    const branch = attemptBranch(spec.playId, spec.demandId, spec.attempt);
    const worktree = join(
      this.#options.worktreeRoot,
      spec.playId,
      `${spec.demandId}-${String(spec.attempt)}`,
    );
    await this.#options.vcs.createWorktree({
      repo: spec.repo,
      path: worktree,
      branch,
      base: spec.base,
    });
    const record: AttemptRecordInput = {
      attemptId,
      playId: spec.playId,
      demandId: spec.demandId,
      attempt: spec.attempt,
      client: spec.profile.client,
      profile: spec.profile.profile,
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
    };
    const context = this.#context(record, spec, spec.prompt);
    await context.journal.write();
    return this.#track(context, {
      resumeSessionId: undefined,
      prompt: spec.prompt,
      cause: undefined,
    });
  }

  /**
   * Continues an attempt that was running when the daemon stopped (or any attempt that is waiting
   * to be resumed) by reloading its conversation. Without a conversation or without the worktree
   * there is nothing to reload: the attempt is marked and the outcome says it needs a decision.
   */
  async resume(record: AttemptRecord, resolved: ResumeContext): Promise<AttemptOutcome> {
    this.#assertOpen();
    const input: AttemptRecordInput = {
      ...attemptInputOf(record),
      state: 'resuming',
      cause: 'daemon_restart',
    };
    const context = this.#context(input, { ...resolved, ...ids(record) }, '');
    const missing = await this.#missingToResume(record);
    const decision = decideInterruption(
      { ...this.#facts(context, 'daemon_restart'), reloadable: missing === undefined },
      this.#rules(),
    );
    if (missing !== undefined) {
      await context.journal.write(undefined, { state: 'interrupted', cause: missing });
      await this.#settleRestartRow(context, decision, [`resolver:${missing}`]);
      await context.journal.flush();
      return this.#outcome(context, 'interrupted', missing, undefined, true, decision);
    }
    // A daemon that was killed left no trace of the interruption: record it now, and commit what
    // the Executor had written (a graceful stop did both already).
    if (record.state !== 'awaiting_resume') {
      context.sessionOpen = true;
      const sha = await this.#checkpoint(context, 'daemon_restart');
      await this.#interruptionEvent(context, decision, 'the daemon was not running', sha, [
        'daemon:not_running',
        `action:${decision.action}`,
      ]);
      await this.#closed(context, 'interrupted', { state: 'resuming', cause: 'daemon_restart' });
    } else {
      // The graceful stop wrote the row without knowing how the restart would continue.
      await this.#settleRestartRow(context, decision, []);
    }
    context.crashes = await this.#crashesOf(context);
    await context.journal.write(undefined, { state: 'resuming', cause: 'daemon_restart' });
    return this.#track(context, {
      resumeSessionId: record.sessionId ?? undefined,
      prompt: this.#options.settings.continuePrompt,
      cause: 'daemon_restart',
    });
  }

  /**
   * Stops every attempt in progress the way a restart does: checkpoint, `session.interrupted` with
   * `daemon_restart`, session closed, and the registry left as `awaiting_resume`, which is what
   * the reconciliation of the next start picks up.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    const all = [...this.#running.values()];
    for (const { context } of all) context.stop.abort();
    await Promise.allSettled(all.map((entry) => entry.done));
  }

  // ---- setup ----

  #assertOpen(): void {
    if (this.#stopping) throw new AdapterUnavailable('the attempt runner is stopped');
  }

  #context(
    record: AttemptRecordInput,
    spec: AttemptContext['spec'],
    firstPrompt: string,
  ): AttemptContext {
    const { store, vcs, clock, settings, logger } = this.#options;
    const journal = new AttemptJournal(store, clock, record);
    const timeoutMs = Math.min(spec.timeoutMs ?? settings.timeoutMs, settings.timeoutMaxMs);
    const tracker = new CheckpointTracker({
      vcs,
      clock,
      journal,
      worktree: record.worktree,
      branch: record.branch,
      correlation: {
        playId: record.playId,
        demandId: record.demandId,
        attemptId: record.attemptId,
      },
      editBatch: settings.checkpointEditBatch,
      everyMs: settings.checkpointEveryMs,
      onError: (error) => {
        logger.warn({ err: error, attemptId: record.attemptId }, 'a checkpoint failed');
      },
    });
    return {
      attemptId: record.attemptId,
      spec,
      branch: record.branch,
      worktree: record.worktree,
      journal,
      tracker,
      stop: new AbortController(),
      deadline: clock.now() + timeoutMs,
      firstPrompt,
      sessionId: record.sessionId ?? undefined,
      sessionOpen: false,
      lease: undefined,
      pending: undefined,
      lastEventAt: clock.now(),
      lastError: undefined,
      crashes: 0,
    };
  }

  async #missingToResume(record: AttemptRecord): Promise<string | undefined> {
    if (record.sessionId === null) return 'no_session';
    try {
      await stat(record.worktree);
    } catch {
      return 'worktree_missing';
    }
    return undefined;
  }

  /**
   * Gives the `daemon_restart` row of the session the form the restart found: the row a graceful
   * stop wrote has none yet; after a kill, or when the row is missing, it is created. Without a
   * session there is no row (the table is keyed by session).
   */
  async #settleRestartRow(
    context: AttemptContext,
    decision: InterruptionDecision,
    signals: readonly string[],
  ): Promise<void> {
    const { sessionId, spec } = context;
    if (sessionId === undefined) return;
    const { store } = this.#options;
    const rows = await store.interruptions.list({ sessionId, causes: ['daemon_restart'] });
    const open = rows.filter((row) => row.resumeForm === null).at(-1);
    if (open !== undefined && decision.form !== null) {
      await store.interruptions.update(open.id, {
        resumeForm: decision.form,
        signals: [...open.signals, ...signals, `action:${decision.action}`],
      });
      return;
    }
    await store.interruptions.create({
      sessionId,
      playId: spec.playId,
      cause: 'daemon_restart',
      signals: [...signals, `action:${decision.action}`],
      resumeForm: decision.form,
      fromExecutor: this.#executorId(context),
      toExecutor: null,
      countedAsAttempt: false,
    });
  }

  /** The drops of the client this attempt had before (free ones excluded), read back after a restart. */
  async #crashesOf(context: AttemptContext): Promise<number> {
    const { sessionId } = context;
    if (sessionId === undefined) return 0;
    const rows = await this.#options.store.interruptions.list({
      sessionId,
      causes: ['client_crash'],
    });
    return rows.filter((row) => !row.signals.includes(FREE_SIGNAL)).length;
  }

  #track(context: AttemptContext, first: Step): Promise<AttemptOutcome> {
    const done = this.#guarded(context, first);
    this.#running.set(context.attemptId, { context, done });
    return done.finally(() => {
      this.#running.delete(context.attemptId);
    });
  }

  /** Runs the attempt; an error nobody planned for (the store, say) still ends the process tree. */
  async #guarded(context: AttemptContext, first: Step): Promise<AttemptOutcome> {
    try {
      const outcome = await this.#drive(context, first);
      await context.journal.flush();
      return outcome;
    } catch (error) {
      this.#options.logger.error({ err: error, attemptId: context.attemptId }, 'attempt aborted');
      await context.lease?.kill().catch(() => undefined);
      await context.lease?.release().catch(() => undefined);
      await context.journal
        .write(undefined, { state: 'failed', cause: describe(error) })
        .catch(() => undefined);
      throw error;
    }
  }

  // ---- the life of an attempt ----

  async #drive(context: AttemptContext, first: Step): Promise<AttemptOutcome> {
    const { settings } = this.#options;
    let step = first;
    for (;;) {
      const ended = await this.#once(context, step);
      switch (ended.kind) {
        case 'finished':
          return this.#finished(context, ended.stopReason);
        case 'failed':
          return this.#failed(context, ended.message);
        case 'timeout':
          return this.#timedOut(context, ended.sha);
        case 'stopped':
          return this.#stopped(context, ended.sha);
        case 'interrupted': {
          const { journal } = context;
          // The policy of 5.16 decides first, so the event and the row carry what it decided.
          const { decision, free, signals } = await this.#decide(context, ended);
          await this.#interrupted(context, ended, decision, signals);
          // Only the resume in place is carried out here. A handoff (P18), a wait for the reset
          // (P19), the cap's `finish` and `stop` (P11) and the Director's judgment stop the
          // attempt, and the outcome says which action the policy chose.
          if (decision.action !== 'resume_native') return this.#parked(context, decision);
          const resumes = journal.record.resumes;
          // The allowance is recorded in the same write that parks the attempt, so a restart
          // from here on continues counting from what was granted (N67).
          await journal.write(undefined, {
            state: 'awaiting_resume',
            cause: decision.cause,
            ...(free ? { freeResumes: journal.record.freeResumes + 1 } : {}),
          });
          const waited = await this.#pause(context, decision.delayMs);
          if (waited === 'timeout') return this.#timedOut(context, ended.sha);
          if (waited === 'stopped') return this.#stopped(context, ended.sha);
          await journal.write(undefined, {
            state: 'resuming',
            resumes: free ? resumes : resumes + 1,
          });
          step = {
            resumeSessionId: context.sessionId,
            prompt: context.sessionId === undefined ? context.firstPrompt : settings.continuePrompt,
            cause: decision.cause,
          };
        }
      }
    }
  }

  /** One go: a session from the pool, the prompt, and the end of that session. */
  async #once(context: AttemptContext, step: Step): Promise<Ended> {
    const { pool } = this.#options;
    const { spec } = context;
    // A new token for each go, also for the reload of a conversation (`session/load`): the MCP
    // servers of a session are the ones of the call that opens it, so the old token is gone.
    const grant = this.#grant(context);
    let lease: SessionLease;
    try {
      lease = await pool.acquire({
        client: spec.profile.client,
        profile: spec.profile,
        policy: spec.policy,
        cwd: context.worktree,
        ...(step.resumeSessionId === undefined ? {} : { resumeSessionId: step.resumeSessionId }),
        ...(grant === undefined ? {} : { mcpServers: [grant.server] }),
        permissions: {
          onDecision: (outcome) => {
            this.#onPermission(context, outcome);
          },
          resolvePath: resolveExistingPath,
        },
        signal: context.stop.signal,
      });
    } catch (error) {
      grant?.revoke();
      if (context.stop.signal.aborted && hasErrorCode(error, 'CANCELLED')) {
        return { kind: 'stopped', sha: await this.#checkpoint(context, 'stopped') };
      }
      return this.#classify(error, step.resumeSessionId !== undefined);
    }
    grant?.bind(lease.session.sessionId);
    context.lease = lease;
    // `session.opened` means "the session is configured": until it is written, the updates wait.
    context.pending = [];
    const guard = new AbortController();
    const subscription = lease.session.onUpdate((update) => {
      this.#onUpdate(context, lease.session.sessionId, update);
    });
    let ended: Ended;
    try {
      ended = await this.#turn(context, step, lease, guard.signal);
    } finally {
      guard.abort();
      subscription.dispose();
      this.#dropPending(context);
    }
    await context.tracker.settled();
    ended = this.#casualty(lease, ended);
    ended = await this.#beforeClosing(context, lease, ended);
    await lease.release().catch(() => undefined);
    grant?.revoke();
    context.lease = undefined;
    return ended;
  }

  /**
   * The door of the framework MCP server for one go of an attempt (architecture 5.3). There is one
   * only when the daemon runs the server, the attempt has a role and the policy of the role lists
   * the server (`policy.mcpServers` has `otheater`); otherwise the session runs without it.
   */
  #grant(context: AttemptContext): McpGrant | undefined {
    const { mcp } = this.#options;
    const { spec } = context;
    if (mcp === undefined || spec.role === undefined) return undefined;
    if (!spec.policy.mcpServers.includes(FRAMEWORK_MCP_NAME)) return undefined;
    const tools = mcpToolsOf(spec.policy, FRAMEWORK_MCP_NAME);
    return mcp.grant({
      attemptId: context.attemptId,
      role: spec.role,
      ...(tools === 'all' ? {} : { tools }),
      correlation: this.#correlation(context),
      worktree: context.worktree,
      networkAllow: spec.policy.network.allow,
      record: (event) => context.journal.write(event),
    });
  }

  /**
   * The WIP commit comes first, so what the Executor wrote survives whatever happens to the
   * process; then `session/cancel`, then the kill of the tree.
   */
  async #beforeClosing(context: AttemptContext, lease: SessionLease, ended: Ended): Promise<Ended> {
    if (ended.kind === 'finished') return ended;
    let result = ended;
    if (ended.kind !== 'failed' && ended.sha === undefined) {
      const sha = await this.#checkpoint(context, causeOf(ended));
      result = { ...ended, sha };
    } else if (ended.kind === 'failed') {
      await this.#checkpoint(context, 'failed');
    }
    const cancelled = ended.kind === 'timeout' || ended.kind === 'stopped';
    if (cancelled) {
      await lease.session.cancel().catch(() => undefined);
      await this.#escalation(context, lease);
    }
    // A shared process is not ours to end after a cancel: `pool.shared_cancel` decided already,
    // and it is gone for the sessions that fell with another session's cancel.
    const kill =
      (cancelled && !lease.shared) ||
      (ended.kind === 'interrupted' && ended.kill && !lease.casualty);
    if (kill) {
      const report = await lease.kill().catch(() => undefined);
      if (report !== undefined && report.remaining.length > 0) {
        this.#options.logger.error(
          { attemptId: context.attemptId, remaining: report.remaining },
          'processes left after the kill of the attempt',
        );
      }
    }
    return result;
  }

  /**
   * A session that lost its connection because another session's cancel ended the shared process
   * did not meet a failure of the client: its resume is free (`Ended.free`).
   */
  #casualty(lease: SessionLease, ended: Ended): Ended {
    if (ended.kind !== 'interrupted' || ended.cause !== 'client_crash' || !lease.casualty) {
      return ended;
    }
    return {
      ...ended,
      free: true,
      detail: 'the adapter process was ended by the cancel of another session (pool.shared_cancel)',
    };
  }

  /** Tells the event log when the cancel of this session ended the shared process. */
  async #escalation(context: AttemptContext, lease: SessionLease): Promise<void> {
    const { escalation } = lease;
    const mode = this.#options.settings.pool.sharedCancel;
    const { sessionId } = context;
    if (escalation === undefined || mode === 'release' || sessionId === undefined) return;
    await context.journal
      .write(
        buildDaemonEvent('session.cancel_escalated', {
          sessionId,
          mode,
          pid: escalation.pid,
          siblings: escalation.siblings,
          ...this.#correlation(context),
        }),
      )
      .catch(() => undefined);
  }

  async #turn(
    context: AttemptContext,
    step: Step,
    lease: SessionLease,
    signal: AbortSignal,
  ): Promise<Ended> {
    const { clock } = this.#options;
    const { session } = lease;
    const sessionId = session.sessionId;
    const { journal } = context;
    try {
      if (step.resumeSessionId === undefined) await this.#configure(context, lease);
      context.sessionId = sessionId;
      context.sessionOpen = true;
      const now = clock.now();
      context.lastEventAt = now;
      await journal.write(
        buildDaemonEvent('session.opened', {
          sessionId,
          executor: this.#executor(context),
          via: lease.via,
          cwd: context.worktree,
          canLoad: session.canLoad,
          ...this.#correlation(context),
        }),
        { state: 'executing', cause: null, sessionId, lastEventAt: now },
      );
      if (step.resumeSessionId !== undefined) {
        await journal.write(
          buildDaemonEvent('session.resumed', {
            sessionId,
            previousSessionId: step.resumeSessionId,
            form: 'native',
            from: this.#executor(context),
            to: this.#executor(context),
            ...(step.cause === undefined ? {} : { cause: step.cause }),
            ...this.#correlation(context),
          }),
        );
      }
      this.#flushPending(context);
    } catch (error) {
      // `session.opened` is in the log (even if `session.resumed` was not): the session is
      // closed with a `session.closed` later, so what it said belongs in the log too.
      if (context.sessionOpen) this.#flushPending(context);
      return this.#classify(error, step.resumeSessionId !== undefined);
    }

    const started = clock.now();
    context.tracker.startInterval(signal);
    const prompt: Promise<Raced> = session.prompt([{ type: 'text', text: step.prompt }]).then(
      (outcome) => ({ kind: 'finished', stopReason: outcome.stopReason }) as const,
      (error: unknown) => ({ kind: 'error', error }) as const,
    );
    const raced = await Promise.race([
      prompt,
      this.#after<Raced>(
        context.deadline - clock.now(),
        { kind: 'timeout', sha: undefined },
        signal,
      ),
      this.#watchdog(context, signal),
      new Promise<Raced>((resolve) => {
        const onStop = (): void => {
          resolve({ kind: 'stopped', sha: undefined });
        };
        if (context.stop.signal.aborted) onStop();
        else context.stop.signal.addEventListener('abort', onStop, { once: true });
      }),
    ]);

    if (raced.kind === 'error') return this.#classify(raced.error, false);
    if (raced.kind !== 'finished') return raced;
    await journal.write(
      buildDaemonEvent('session.prompt_finished', {
        sessionId,
        stopReason: raced.stopReason,
        durationMs: clock.now() - started,
        ...this.#correlation(context),
      }),
    );
    if (raced.stopReason === 'refusal') {
      return {
        kind: 'interrupted',
        cause: 'refusal',
        detail: 'the model refused to continue',
        native: false,
        kill: false,
        signals: ['stop_reason:refusal'],
        sha: undefined,
      };
    }
    if (raced.stopReason === 'cancelled') {
      return { kind: 'failed', message: 'the turn was cancelled from outside' };
    }
    return raced;
  }

  async #configure(context: AttemptContext, lease: SessionLease): Promise<void> {
    const adapter = this.#options.pool.adapterOf(context.spec.profile.client);
    const options = adapter.configOptionsFor(context.spec.executor);
    for (const [id, value] of Object.entries(options)) {
      await lease.session.setConfig(id, value);
    }
  }

  /** `stuck.no_event_for` with no event of the session: the process is stuck. */
  async #watchdog(context: AttemptContext, signal: AbortSignal): Promise<Ended> {
    const limit = this.#options.settings.stuckNoEventMs;
    if (limit <= 0) return NEVER;
    const { clock } = this.#options;
    for (;;) {
      const wait = limit - (clock.now() - context.lastEventAt);
      if (wait <= 0) {
        return {
          kind: 'interrupted',
          cause: 'stuck',
          detail: `no event for ${String(limit)} ms`,
          native: false,
          kill: true,
          signals: [`no_event_for:${String(limit)}ms`],
          sha: undefined,
        };
      }
      try {
        await clock.sleep(wait, signal);
      } catch {
        return NEVER;
      }
    }
  }

  #after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
    if (ms <= 0) return Promise.resolve(value);
    return this.#options.clock.sleep(ms, signal).then(
      () => value,
      () => NEVER,
    );
  }

  #onUpdate(context: AttemptContext, sessionId: string, update: NormalizedUpdate): void {
    try {
      // Whatever the client sends is activity, buffered or not: the stuck watch keeps counting.
      const now = context.journal.touch();
      context.lastEventAt = now;
      if (context.pending !== undefined) {
        context.pending.push({ sessionId, update });
        return;
      }
      this.#record(context, sessionId, update, now);
    } catch (error) {
      this.#options.logger.warn(
        { err: error, attemptId: context.attemptId },
        'update not recorded',
      );
    }
  }

  /**
   * Layer 2 answered a request of the client: `permission.asked` and `permission.answered` go to the
   * log, in that order, for every request, whatever the policy (`onAsk: reject` included). The
   * answer has already gone back to the client; a failure here only costs the events.
   */
  #onPermission(context: AttemptContext, outcome: PermissionOutcome): void {
    try {
      const sessionId = context.lease?.session.sessionId ?? 'unopened';
      const events = permissionEventsOf(outcome, { sessionId, ...this.#correlation(context) });
      const now = context.journal.touch();
      context.lastEventAt = now;
      for (const event of events) void context.journal.write(event, { lastEventAt: now });
    } catch (error) {
      this.#options.logger.warn(
        { err: error, attemptId: context.attemptId },
        'permission events not recorded',
      );
    }
  }

  #record(context: AttemptContext, sessionId: string, update: NormalizedUpdate, now: number): void {
    void context.journal.write(
      buildDaemonEvent('session.update', {
        sessionId,
        update,
        ...this.#correlation(context),
      }),
      { lastEventAt: now },
    );
    context.tracker.observe(update);
  }

  /**
   * Records the updates that came before `session.opened`, right after it (and after
   * `session.resumed`), so the log reads opened, [resumed], updates, ... The journal queues writes
   * in the order they are asked for, and `pending` is emptied in the same synchronous step, so an
   * update that arrives meanwhile goes straight to the journal behind these.
   */
  #flushPending(context: AttemptContext): void {
    const { pending } = context;
    context.pending = undefined;
    for (const { sessionId, update } of pending ?? []) {
      try {
        this.#record(context, sessionId, update, context.journal.touch());
      } catch (error) {
        this.#options.logger.warn(
          { err: error, attemptId: context.attemptId },
          'update not recorded',
        );
      }
    }
  }

  /**
   * The turn ended and `session.opened` was never written (the configuration or the write failed):
   * the updates are dropped, with a warning. The log would hold events of a session that has no
   * `session.opened` and, with `sessionOpen` false, no `session.closed` either, and the failure
   * itself is what gets classified and recorded; the checkpoint tracker never saw them, which is
   * right for a session that did not start working.
   */
  #dropPending(context: AttemptContext): void {
    const { pending } = context;
    context.pending = undefined;
    if (pending === undefined || pending.length === 0) return;
    this.#options.logger.warn(
      { attemptId: context.attemptId, dropped: pending.length },
      'updates dropped: the session ended before session.opened was recorded',
    );
  }

  // ---- errors ----

  /**
   * The classification of an error into a cause (architecture 5.16): what the client or the pool
   * reported. What to do about it is `decideInterruption`.
   */
  #classify(error: unknown, resuming: boolean): Ended {
    const detail = describe(error);
    const interrupted = (
      cause: InterruptionCause,
      native: boolean,
      kill: boolean,
      signals: readonly string[],
      limitHit?: LimitHit,
    ): Ended => ({
      kind: 'interrupted',
      cause,
      detail,
      native,
      kill,
      signals,
      ...(limitHit === undefined ? {} : { limitHit }),
      sha: undefined,
    });
    if (hasErrorCode(error, 'TRANSIENT')) {
      return interrupted('transient', true, false, ['error_code:TRANSIENT']);
    }
    if (hasErrorCode(error, 'ADAPTER_UNAVAILABLE')) {
      return interrupted('client_crash', true, true, ['error_code:ADAPTER_UNAVAILABLE']);
    }
    const limitHit = limitHitOf(error);
    if (hasErrorCode(error, 'QUOTA_EXHAUSTED') || limitHit !== undefined) {
      return interrupted(
        'quota_exhausted',
        false,
        false,
        [limitHit?.source ?? 'error_code:QUOTA_EXHAUSTED'],
        limitHit,
      );
    }
    if (hasErrorCode(error, 'PERMISSION_DENIED')) {
      return interrupted('permission', false, false, ['error_code:PERMISSION_DENIED']);
    }
    if (resuming && hasErrorCode(error, 'NOT_FOUND')) {
      // `session/load` of a conversation the client no longer has: only a handoff continues.
      return interrupted('client_crash', false, false, [
        'error_code:NOT_FOUND',
        'session_load:failed',
      ]);
    }
    return { kind: 'failed', message: detail };
  }

  // ---- the policy by cause (5.16) ----

  /** The values of `resume.*` the policy reads. */
  #rules(): InterruptionRules {
    const { settings } = this.#options;
    return {
      maxResumes: settings.maxResumes,
      quotaWaitMaxMs: settings.quotaWaitMaxMs,
      transientBackoffMs: settings.transientBackoffMs,
      transientExhausted: settings.transientExhausted,
      clientCrashCounts: settings.clientCrashCounts,
      stuckSameErrorTimes: settings.stuckSameErrorTimes,
    };
  }

  /** The facts of an interruption nothing special is known about. */
  #facts(context: AttemptContext, cause: InterruptionCause): InterruptionFacts {
    const { spec, journal } = context;
    return {
      cause,
      now: this.#options.clock.now(),
      resetsAt: null,
      whenExhausted: spec.whenExhausted ?? 'next',
      inFlight: spec.inFlight ?? 'handoff',
      reloadable: true,
      free: false,
      resumes: journal.record.resumes,
      repeated: 0,
      priorCrashes: context.crashes,
    };
  }

  /**
   * Gathers the facts of an interruption and asks the policy. `free` is whether the drop was a
   * casualty of another session's cancel and the allowance (`resume.max_free_resumes`) has room:
   * such a resume costs no `resume.max_resumes` and no attempt.
   */
  async #decide(
    context: AttemptContext,
    ended: Extract<Ended, { kind: 'interrupted' }>,
  ): Promise<{ decision: InterruptionDecision; free: boolean; signals: readonly string[] }> {
    const { journal } = context;
    const free =
      ended.free === true && journal.record.freeResumes < this.#options.settings.maxFreeResumes;
    const repeated = free ? 0 : this.#repeated(context, `${ended.cause}:${ended.detail}`);
    let cause = ended.cause;
    let resetsAt: number | null = null;
    let signals = ended.signals;
    if (ended.cause === 'quota_exhausted') {
      const quota = await this.#quotaOf(context, ended);
      cause = quota.cause;
      resetsAt = quota.resetsAt;
      signals = [...signals, ...quota.signals];
    }
    // The conversation of an exhausted quota can be reloaded when there is one (the error came
    // from a turn); the other causes know it from how they were classified.
    const reloadable =
      ended.native ||
      ((cause === 'quota_exhausted' || cause === 'spend_cap') && context.sessionId !== undefined);
    const decision = decideInterruption(
      { ...this.#facts(context, cause), resetsAt, reloadable, free, repeated },
      this.#rules(),
    );
    if (cause === 'client_crash' && !free) context.crashes += 1;
    return {
      decision,
      free,
      signals: [...signals, ...(free ? [FREE_SIGNAL] : []), `action:${decision.action}`],
    };
  }

  /** What the `QuotaService` says about a limit error: the cause (quota or cap) and the reset. */
  async #quotaOf(
    context: AttemptContext,
    ended: Extract<Ended, { kind: 'interrupted' }>,
  ): Promise<{ cause: InterruptionCause; resetsAt: number | null; signals: string[] }> {
    const { quota, logger } = this.#options;
    const unknown = { cause: ended.cause, resetsAt: null, signals: [] };
    if (quota === undefined) return unknown;
    try {
      const status = await quota.ingestLimitHit(
        context.spec.profile.id,
        ended.limitHit ?? { source: 'error:QuotaExhausted' },
      );
      return {
        cause:
          status.state === 'exhausted' && status.cause === 'budget' ? 'spend_cap' : ended.cause,
        resetsAt: status.untilReset,
        signals: [
          `quota_state:${status.state}`,
          ...(status.untilReset === null
            ? []
            : [`resets_at:${new Date(status.untilReset).toISOString()}`]),
        ],
      };
    } catch (error) {
      logger.warn({ err: error, attemptId: context.attemptId }, 'the quota service did not answer');
      return unknown;
    }
  }

  /** How many times in a row the same interruption came up. */
  #repeated(context: AttemptContext, key: string): number {
    const count = context.lastError?.key === key ? context.lastError.count + 1 : 1;
    context.lastError = { key, count };
    return count;
  }

  /** The wait before a native resume (the backoff the policy chose); a stop or the deadline ends it. */
  async #pause(context: AttemptContext, ms: number): Promise<'ok' | 'timeout' | 'stopped'> {
    const { clock } = this.#options;
    const guard = new AbortController();
    try {
      const result = await Promise.race([
        this.#after(ms, 'ok' as const, guard.signal),
        this.#after(context.deadline - clock.now(), 'timeout' as const, guard.signal),
        new Promise<'stopped'>((resolve) => {
          const onStop = (): void => {
            resolve('stopped');
          };
          if (context.stop.signal.aborted) onStop();
          else context.stop.signal.addEventListener('abort', onStop, { once: true });
        }),
      ]);
      return result;
    } finally {
      guard.abort();
    }
  }

  // ---- ends ----

  async #checkpoint(context: AttemptContext, detail: string): Promise<string | undefined> {
    try {
      return await context.tracker.take('interruption', detail);
    } catch (error) {
      this.#options.logger.warn({ err: error, attemptId: context.attemptId }, 'checkpoint failed');
      return context.journal.record.lastCheckpoint ?? undefined;
    }
  }

  #executor(context: AttemptContext): ExecutorPayload {
    const { profile, executor } = context.spec;
    return {
      client: profile.client,
      profile: profile.profile,
      model: executor.model,
      ...(executor.effort === undefined ? {} : { effort: executor.effort }),
      ...(executor.mode === undefined ? {} : { mode: executor.mode }),
    };
  }

  #correlation(context: AttemptContext): { playId: string; demandId: string; attemptId: string } {
    return {
      playId: context.spec.playId,
      demandId: context.spec.demandId,
      attemptId: context.attemptId,
    };
  }

  async #closed(
    context: AttemptContext,
    reason: 'completed' | 'cancelled' | 'failed' | 'interrupted',
    patch: AttemptPatch,
  ): Promise<void> {
    const { sessionId, sessionOpen } = context;
    await context.journal.write(
      sessionId === undefined || !sessionOpen
        ? undefined
        : buildDaemonEvent('session.closed', { sessionId, reason, ...this.#correlation(context) }),
      patch,
    );
    context.sessionOpen = false;
  }

  async #interrupted(
    context: AttemptContext,
    ended: Extract<Ended, { kind: 'interrupted' }>,
    decision: InterruptionDecision,
    signals: readonly string[],
  ): Promise<void> {
    await this.#interruptionEvent(context, decision, ended.detail, ended.sha, signals);
    await this.#closed(context, 'interrupted', { state: 'interrupted', cause: decision.cause });
  }

  /**
   * `session.interrupted` and the row of `interruptions`, in one transaction: the event carries the
   * cause (and the reset time, when known), the row what the policy decided. Both need an opened
   * session; an error before any session existed leaves neither.
   */
  async #interruptionEvent(
    context: AttemptContext,
    decision: InterruptionDecision,
    detail: string,
    sha: string | undefined,
    signals: readonly string[],
  ): Promise<void> {
    const { sessionId, sessionOpen, spec } = context;
    if (sessionId === undefined || !sessionOpen) return;
    await context.journal.write(
      buildDaemonEvent('session.interrupted', {
        sessionId,
        cause: decision.cause,
        detail,
        ...(decision.resetsAt === null ? {} : { resetsAt: decision.resetsAt }),
        ...(sha === undefined ? {} : { checkpointSha: sha }),
        ...this.#correlation(context),
      }),
      undefined,
      {
        sessionId,
        playId: spec.playId,
        cause: decision.cause,
        signals: [...signals],
        resumeForm: decision.form,
        fromExecutor: this.#executorId(context),
        toExecutor: null,
        countedAsAttempt: decision.countsAsAttempt,
      },
    );
  }

  /** The Executor id of the row of `interruptions`: `<model>[-<effort>]@<client>/<profile>`. */
  #executorId(context: AttemptContext): string {
    const { profile, executor } = context.spec;
    return formatExecutorId({
      model: executor.model,
      effort: executor.effort ?? null,
      profileId: profile.id,
    });
  }

  async #finished(context: AttemptContext, stopReason: StopReason): Promise<AttemptOutcome> {
    await this.#closed(context, 'completed', { state: 'completed', cause: null });
    await context.journal.flush();
    return this.#outcome(context, 'completed', undefined, stopReason, false);
  }

  async #failed(context: AttemptContext, message: string): Promise<AttemptOutcome> {
    await this.#closed(context, 'failed', { state: 'failed', cause: message });
    await context.journal.flush();
    // A failure of the agent is what an attempt of the demand is for.
    return this.#outcome(context, 'failed', message, undefined, false);
  }

  async #timedOut(context: AttemptContext, sha: string | undefined): Promise<AttemptOutcome> {
    const decision = decideInterruption(this.#facts(context, 'timeout'), this.#rules());
    await this.#interruptionEvent(
      context,
      decision,
      'the attempt reached its deadline',
      sha ?? context.journal.record.lastCheckpoint ?? undefined,
      ['deadline', `action:${decision.action}`],
    );
    await this.#closed(context, 'interrupted', { state: 'timed_out', cause: 'timeout' });
    await context.journal.flush();
    return this.#outcome(context, 'timed_out', 'timeout', undefined, true, decision);
  }

  /**
   * The daemon stops: the next start resumes the conversation, so the row says `native` once the
   * restart is known to find it (`resume()` settles it; until then the form is not known).
   */
  async #stopped(context: AttemptContext, sha: string | undefined): Promise<AttemptOutcome> {
    const decision = {
      ...decideInterruption(this.#facts(context, 'daemon_restart'), this.#rules()),
      form: null,
    };
    await this.#interruptionEvent(
      context,
      decision,
      'the daemon stopped',
      sha ?? context.journal.record.lastCheckpoint ?? undefined,
      ['daemon:stopping', `action:${decision.action}`],
    );
    await this.#closed(context, 'interrupted', {
      state: 'awaiting_resume',
      cause: 'daemon_restart',
    });
    await context.journal.flush();
    return this.#outcome(context, 'interrupted', 'daemon_restart', undefined, false, decision);
  }

  /**
   * Stopped for an action this runner does not carry out (a handoff, a wait for the reset, the
   * cap's `finish` and `stop`, the Director's judgment). The registry keeps it as `interrupted`
   * and the outcome says what the policy chose.
   */
  async #parked(context: AttemptContext, decision: InterruptionDecision): Promise<AttemptOutcome> {
    await context.journal.write(undefined, { state: 'interrupted', cause: decision.cause });
    await context.journal.flush();
    return this.#outcome(context, 'interrupted', decision.cause, undefined, true, decision);
  }

  #outcome(
    context: AttemptContext,
    state: AttemptResultState,
    cause: string | undefined,
    stopReason: StopReason | undefined,
    needsDecision: boolean,
    decision?: InterruptionDecision,
  ): AttemptOutcome {
    const record = context.journal.record;
    return {
      attemptId: context.attemptId,
      state,
      cause,
      stopReason,
      sessionId: context.sessionId,
      checkpointSha: record.lastCheckpoint ?? undefined,
      branch: context.branch,
      worktree: context.worktree,
      resumes: record.resumes,
      needsDecision,
      decision,
      countsAsAttempt: state === 'failed' || decision?.countsAsAttempt === true,
    };
  }
}

function ids(record: AttemptRecord): { playId: string; demandId: string; attempt: number } {
  return { playId: record.playId, demandId: record.demandId, attempt: record.attempt };
}

function causeOf(ended: Ended): string {
  switch (ended.kind) {
    case 'interrupted':
      return ended.cause;
    case 'timeout':
      return 'timeout';
    case 'stopped':
      return 'daemon_restart';
    default:
      return ended.kind;
  }
}

function describe(error: unknown): string {
  if (error instanceof Cancelled) return `cancelled: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
