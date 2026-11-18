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
  type SelectionResult,
  type StopReason,
  type Store,
  type Vcs,
  type WhenExhausted,
} from '@otheater/core';
import {
  buildDaemonEvent,
  type ExecutorPayload,
  type InterruptionCause,
  type PackageSummary,
  type ScenarioHandoffNotice,
} from '@otheater/protocol';
import { FRAMEWORK_MCP_NAME, type McpAccess, type McpGrant } from '../mcp/access.js';
import { executorSelectedPayload } from '../orchestration/executor-selection.js';
import { CheckpointTracker } from './checkpoints.js';
import {
  eventErrorText,
  gatherContinuationPackage,
  renderContinuationPackage,
} from './continuation-package.js';
import type { HandoffPort, HandoffRequest, HandoffTarget } from './handoff.js';
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
  /**
   * The ref the attempt branch was cut from. The continuation package of a handoff shows the
   * difference against it; without it the package says the difference is not known.
   */
  readonly base?: string;
  readonly profile: Profile;
  readonly executor: ExecutorConfig;
  readonly policy: RolePolicy;
  readonly timeoutMs?: number;
  readonly whenExhausted?: WhenExhausted;
  readonly inFlight?: InFlightMode;
}

export const ATTEMPT_RESULT_STATES = ['completed', 'failed', 'timed_out', 'interrupted'] as const;
export type AttemptResultState = (typeof ATTEMPT_RESULT_STATES)[number];

/** One passing of the baton inside an attempt (architecture 5.16; Phase 5, P18). */
export interface HandoffRecord {
  readonly cause: string;
  /** Executor ids, `<model>[-<effort>]@<client>/<profile>`. */
  readonly from: string;
  readonly to: string;
  /** The conversation the baton came from; undefined when the previous Executor never opened one. */
  readonly previousSessionId: string | undefined;
  /** The policy counted the interruption as an attempt of the demand (`stuck`); the handoff itself spends none. */
  readonly countedAsAttempt: boolean;
  /** Size of the first prompt of the new session, in characters. */
  readonly packageChars: number;
  /** How much of the package was cut to fit `resume.package.max_chars` (0: nothing, 4: a hard cut). */
  readonly packageLevel: number;
  /** The package lost its middle: `packageLevel` is the last one (P18b). */
  readonly packageCut: boolean;
  /** How the summary of the package was made; `model_failed` and `model_unavailable` are fallbacks (P18b). */
  readonly summary: PackageSummary;
  /** Why the cheap model did not contribute, masked (P18b). */
  readonly summaryError: string | undefined;
}

/** Why a handoff the policy asked for did not happen, when no Executor was there to take it. */
export interface HandoffWait {
  /** `no_port`, `no_role`, `no_other_executor`, `waiting`, `selection_failed`, `package_failed`. */
  readonly reason: string;
  /** The Executors whose availability may come back (the wait of the selector); empty when none will. */
  readonly on: readonly string[];
  /** The earliest known end of the wait (epoch ms); null when no source says. */
  readonly until: number | null;
  /** What failed (`selection_failed`, `package_failed`), masked and cut; never the raw message (P18b). */
  readonly error?: string;
}

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
  /** The batons passed inside this attempt, in order (P18). A handoff spends no attempt of the demand. */
  readonly handoffs: readonly HandoffRecord[];
  /** Set when the policy chose a handoff and no Executor took it: the attempt is parked. */
  readonly handoffWait: HandoffWait | undefined;
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
  /**
   * The handoff (P18): the next Executor of the role and what the continuation package needs.
   * Without it a `handoff` decision parks the attempt, as before.
   */
  readonly handoff?: HandoffPort;
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
      /**
       * The profile of the session is leaving (P21, `profiles.drain.on_timeout: handoff`): the
       * session was ended for it and the policy of 5.16 is not asked, the work goes to the next
       * Executor of the role (`#leavingDecision`).
       */
      readonly leaving?: boolean;
      /** What the classification saw: names of signals, never a credential or a prompt. */
      readonly signals: readonly string[];
      /** The limit error behind a `quota_exhausted`, for the `QuotaService`. */
      readonly limitHit?: LimitHit;
      readonly sha: string | undefined;
    }
  | { readonly kind: 'timeout'; readonly sha: string | undefined }
  | {
      readonly kind: 'stopped';
      readonly sha: string | undefined;
      /** The stop is the one of a profile that left with `on_timeout: force` (P21), not the daemon's. */
      readonly leaving?: boolean;
    };

type Raced = Ended | { readonly kind: 'error'; readonly error: unknown };

/** The next session to open: new, or the reload of an earlier one. */
interface Step {
  readonly resumeSessionId: string | undefined;
  readonly prompt: string;
  /** Why the conversation is being reloaded. */
  readonly cause: InterruptionCause | undefined;
  /** Set when the session is the new one of a handoff, with `prompt` the continuation package. */
  readonly handoff?: {
    readonly previousSessionId: string | undefined;
    readonly from: ExecutorPayload;
  };
}

/** What `#prepareHandoff` came to: a target with its package, or why nobody takes the work. */
type Prepared =
  | {
      readonly kind: 'ready';
      readonly target: HandoffTarget;
      readonly selection: SelectionResult | undefined;
      /** The package, as the first prompt of the new session. */
      readonly prompt: string;
      readonly level: number;
      readonly cut: boolean;
      readonly summary: PackageSummary;
      readonly summaryError: string | undefined;
    }
  | {
      readonly kind: 'none';
      readonly wait: HandoffWait;
      readonly selection?: SelectionResult;
    };

interface PendingUpdate {
  readonly sessionId: string;
  readonly update: NormalizedUpdate;
}

interface AttemptContext {
  readonly attemptId: string;
  /** Changes when the baton passes: the profile, the configuration and the policy of the new Executor. */
  spec: ResumeContext & {
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
  /** The package the last handoff opened its session with: what a go with no conversation starts from. */
  handoffPrompt: string | undefined;
  /** The Executors that worked on the attempt, in order; the next handoff never picks one of them. */
  readonly used: string[];
  readonly handoffs: HandoffRecord[];
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
  /**
   * Ends the current go when its profile leaves (P21, `releaseProfile`). A new one for each go: the
   * handoff that follows opens its session in another profile, which has not left.
   */
  leave: AbortController;
  /** The profile this attempt gave up (P21): its session is closed and none will open there again. */
  left: string | undefined;
  /** Whoever waits for the attempt to leave its profile (`releaseProfile`). */
  leftWaiters: (() => void)[];
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
  /** The profiles released (P21) and how: a go that would open a session on one does not. */
  readonly #leaving = new Map<string, 'handoff' | 'force'>();
  #stopping = false;

  constructor(options: AttemptRunnerOptions) {
    this.#options = options;
  }

  /** Attempts in progress. */
  get active(): number {
    return this.#running.size;
  }

  /**
   * Attempts that count for a profile that is draining (P21): the ones whose Executor is in that
   * profile and that have not given it up. An attempt between two goes (the backoff of a resume)
   * counts too, which a count of the pool's leases would miss.
   */
  attemptsOf(profileId: string): number {
    return this.#onProfile(profileId).length;
  }

  /** How many of those hold a lease of the pool now (the pool counts the same sessions). */
  leasedOn(profileId: string): number {
    return this.#onProfile(profileId).filter((context) => context.lease !== undefined).length;
  }

  #onProfile(profileId: string): AttemptContext[] {
    return [...this.#running.values()]
      .map((entry) => entry.context)
      .filter((context) => context.spec.profile.id === profileId && context.left !== profileId);
  }

  /**
   * A profile is leaving (P21, the drain timed out): every attempt on it stops using it, after the
   * checkpoint and the end of its session. `handoff` hands the work to the next Executor of the
   * role (the baton of P18, no attempt of the demand spent); `force` stops the attempt the way the
   * daemon's stop does, leaving it `awaiting_resume` for the reconciliation. Resolves, with the
   * number of attempts touched, when each one has let go of the profile; the handoff itself goes on
   * after that, on the Executor that takes it. A go that would open a session on the profile later
   * (the end of a backoff) is turned away at its start.
   */
  async releaseProfile(profileId: string, how: 'handoff' | 'force'): Promise<number> {
    this.#leaving.set(profileId, how);
    const mine = this.#onProfile(profileId);
    for (const context of mine) context.leave.abort();
    await Promise.all(
      mine.map(
        (context) =>
          new Promise<void>((resolve) => {
            if (context.left === profileId) resolve();
            else context.leftWaiters.push(resolve);
          }),
      ),
    );
    return mine.length;
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
      handoffPrompt: undefined,
      used: [
        formatExecutorId({
          model: spec.executor.model,
          effort: spec.executor.effort ?? null,
          profileId: spec.profile.id,
        }),
      ],
      handoffs: [],
      sessionId: record.sessionId ?? undefined,
      sessionOpen: false,
      lease: undefined,
      pending: undefined,
      lastEventAt: clock.now(),
      lastError: undefined,
      crashes: 0,
      leave: new AbortController(),
      left: undefined,
      leftWaiters: [],
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
      this.#settleLeft(context);
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
        .write(
          buildDaemonEvent('attempt.aborted', {
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            error: eventErrorText(error, { secretPaths: [] }),
            ...this.#correlation(context),
          }),
          { state: 'failed', cause: describe(error) },
        )
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
          return this.#stopped(context, ended.sha, ended.leaving === true);
        case 'interrupted': {
          const { journal } = context;
          // The policy of 5.16 decides first, so the event and the row carry what it decided.
          const { decision, free, signals } =
            ended.leaving === true
              ? this.#leavingDecision(ended)
              : await this.#decide(context, ended);
          // A handoff chooses the next Executor and builds the package before the event is
          // written, so `session.interrupted` already says where the work goes.
          const handoff =
            decision.action === 'handoff'
              ? await this.#prepareHandoff(context, ended, decision)
              : undefined;
          await this.#interrupted(
            context,
            ended,
            decision,
            signals,
            handoff?.kind === 'ready' ? handoff.target : undefined,
          );
          if (handoff?.kind === 'ready') {
            step = await this.#handoff(context, decision, handoff);
            continue;
          }
          // The resume in place and the handoff are carried out here. A wait for the reset (P19),
          // the cap's `finish` and `stop` (P11) and the Director's judgment stop the attempt (and
          // so does a handoff nobody could take), and the outcome says which action the policy
          // chose.
          if (decision.action !== 'resume_native') {
            const wait = handoff?.wait ?? noHandoffPort(decision);
            if (wait !== undefined) await this.#handoffFailed(context, decision, wait);
            return this.#parked(context, decision, wait);
          }
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
            prompt:
              context.sessionId === undefined
                ? (context.handoffPrompt ?? context.firstPrompt)
                : settings.continuePrompt,
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
    // Each go listens to its own signal: the baton that follows a leave opens in another profile.
    context.leave = new AbortController();
    const leaving = this.#leaving.get(spec.profile.id);
    if (leaving !== undefined) {
      // The profile was released while the attempt was between two goes (the backoff of a resume).
      this.#markLeft(context);
      return this.#leavingEnded(leaving, undefined);
    }
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
        signal: AbortSignal.any([context.stop.signal, context.leave.signal]),
      });
    } catch (error) {
      grant?.revoke();
      if (context.stop.signal.aborted && hasErrorCode(error, 'CANCELLED')) {
        return { kind: 'stopped', sha: await this.#checkpoint(context, 'stopped') };
      }
      if (context.leave.signal.aborted && hasErrorCode(error, 'CANCELLED')) {
        // The profile left while the session waited for a slot: no session to close.
        this.#markLeft(context);
        return this.#leavingEnded(this.#leaving.get(spec.profile.id) ?? 'handoff', undefined);
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
    if ((ended.kind === 'interrupted' || ended.kind === 'stopped') && ended.leaving === true) {
      this.#markLeft(context);
    }
    return ended;
  }

  /** How a go ends when its profile leaves: the baton (`handoff`) or the stop of the daemon (`force`). */
  #leavingEnded(how: 'handoff' | 'force', sha: string | undefined): Ended {
    if (how === 'force') return { kind: 'stopped', sha, leaving: true };
    return {
      kind: 'interrupted',
      cause: 'daemon_restart',
      detail: 'the profile of the session is being removed',
      native: false,
      kill: true,
      leaving: true,
      signals: ['profile:leaving'],
      sha,
    };
  }

  /** The attempt let go of the profile of its Executor: whoever waits in `releaseProfile` goes on. */
  #markLeft(context: AttemptContext): void {
    context.left = context.spec.profile.id;
    this.#settleLeft(context);
  }

  #settleLeft(context: AttemptContext): void {
    for (const resolve of context.leftWaiters.splice(0)) resolve();
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
    const cancelled = ended.kind === 'timeout' || ended.kind === 'stopped' || isLeaving(ended);
    if (cancelled) {
      await lease.session.cancel().catch(() => undefined);
      await this.#escalation(context, lease);
    }
    // A shared process is not ours to end after a cancel: `pool.shared_cancel` decided already,
    // and it is gone for the sessions that fell with another session's cancel.
    // A profile that leaves takes its processes with it, shared or not (P21).
    const kill = isLeaving(ended)
      ? !lease.casualty
      : (cancelled && !lease.shared) ||
        (ended.kind === 'interrupted' && ended.kill && !lease.casualty);
    if (kill) {
      const report = await lease.kill().catch(() => undefined);
      if (report !== undefined && report.remaining.length > 0) {
        this.#options.logger.error(
          { attemptId: context.attemptId, remaining: report.remaining },
          'processes left after the kill of the attempt',
        );
        await context.journal.write(
          buildDaemonEvent('session.processes_left', {
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            pids: [...report.remaining],
            ...this.#correlation(context),
          }),
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
    const { journal, spec } = context;
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
      if (step.handoff !== undefined) {
        await journal.write(
          buildDaemonEvent('session.resumed', {
            sessionId,
            ...(step.handoff.previousSessionId === undefined
              ? {}
              : { previousSessionId: step.handoff.previousSessionId }),
            form: 'handoff',
            from: step.handoff.from,
            to: this.#executor(context),
            ...(step.cause === undefined ? {} : { cause: step.cause }),
            ...this.#correlation(context),
          }),
        );
      } else if (step.resumeSessionId !== undefined) {
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
      new Promise<Raced>((resolve) => {
        const onLeave = (): void => {
          resolve(this.#leavingEnded(this.#leaving.get(spec.profile.id) ?? 'handoff', undefined));
        };
        if (context.leave.signal.aborted) onLeave();
        else context.leave.signal.addEventListener('abort', onLeave, { once: true, signal });
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

  /**
   * The decision for a session whose profile is leaving (P21): not one of the table of 5.16, which
   * has no row for it, so the cause is the one that is the same for the work, a loss that is no
   * fault of the Executor (`daemon_restart`), and the action is the baton. It costs no attempt.
   * [proposta] A cause of its own (`profile_removed`) waits for the owner's call on the table.
   */
  #leavingDecision(ended: Extract<Ended, { kind: 'interrupted' }>): {
    decision: InterruptionDecision;
    free: boolean;
    signals: readonly string[];
  } {
    return {
      decision: {
        cause: 'daemon_restart',
        action: 'handoff',
        form: 'handoff',
        countsAsAttempt: false,
        delayMs: 0,
        resetsAt: null,
        differentExecutor: true,
        reason: 'its profile is being removed; the work goes to the next Executor of the role',
      },
      free: false,
      signals: [...ended.signals, 'action:handoff'],
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

  // ---- the handoff (P18) ----

  /**
   * Chooses the next Executor of the role and builds the continuation package, before anything of
   * the interruption is written. Returns undefined when the runner has no port (the attempt is
   * parked, as it always was). A port with nobody to take the work, an error of the selection or
   * of the package leave the attempt parked, with the reason in `AttemptOutcome.handoffWait`.
   */
  async #prepareHandoff(
    context: AttemptContext,
    ended: Extract<Ended, { kind: 'interrupted' }>,
    decision: InterruptionDecision,
  ): Promise<Prepared | undefined> {
    const port = this.#options.handoff;
    if (port === undefined) return undefined;
    const { journal, spec } = context;
    const request: HandoffRequest = {
      attemptId: context.attemptId,
      playId: spec.playId,
      demandId: spec.demandId,
      role: spec.role,
      cause: decision.cause,
      from: this.#executorId(context),
      used: [...context.used],
    };
    const logger = this.#options.logger;
    const scope = { secretPaths: port.secretPaths ?? [], home: port.home };
    let choice: Awaited<ReturnType<HandoffPort['choose']>>;
    try {
      choice = await port.choose(request);
    } catch (error) {
      logger.warn({ err: error, attemptId: context.attemptId }, 'the handoff could not choose');
      return {
        kind: 'none',
        wait: {
          reason: 'selection_failed',
          on: [],
          until: null,
          error: eventErrorText(error, scope),
        },
      };
    }
    if (choice.kind === 'none') {
      const { selection } = choice;
      return {
        kind: 'none',
        wait: {
          reason: choice.reason,
          on: selection?.wait?.on ?? [],
          until: selection?.wait?.until ?? null,
        },
        ...(selection === undefined ? {} : { selection }),
      };
    }
    // The package reads the log of the attempt: what the session wrote must be in it.
    await journal.flush();
    try {
      const { settings } = this.#options;
      const to = choice.target.executorId;
      const pkg = await gatherContinuationPackage(
        {
          store: this.#options.store,
          vcs: this.#options.vcs,
          secretPaths: port.secretPaths ?? [],
          home: port.home,
        },
        {
          attemptId: context.attemptId,
          playId: spec.playId,
          demandId: spec.demandId,
          role: spec.role,
          worktree: context.worktree,
          branch: context.branch,
          base: spec.base,
          checkpoint: ended.sha ?? journal.record.lastCheckpoint ?? null,
          firstPrompt: context.firstPrompt,
          prefix: await port.prefixOf(spec.role),
          reason: {
            cause: decision.cause,
            policy: decision.reason,
            detail: ended.detail,
            from: request.from,
            to,
          },
          settings: settings.package,
        },
        port.summarizer,
      );
      const rendered = renderContinuationPackage(pkg, {
        maxChars: settings.package.maxChars,
        secretPaths: port.secretPaths ?? [],
        home: port.home,
      });
      return {
        kind: 'ready',
        target: choice.target,
        selection: choice.selection,
        prompt: rendered.text,
        level: rendered.level,
        cut: rendered.cut,
        summary: pkg.summary,
        summaryError: pkg.summaryError,
      };
    } catch (error) {
      logger.warn({ err: error, attemptId: context.attemptId }, 'the continuation package failed');
      return {
        kind: 'none',
        wait: {
          reason: 'package_failed',
          on: [],
          until: null,
          error: eventErrorText(error, scope),
        },
        ...(choice.selection === undefined ? {} : { selection: choice.selection }),
      };
    }
  }

  /**
   * Passes the baton (architecture 5.16): the registry goes `interrupted` (written by the caller),
   * `awaiting_resume`, then `resuming` with the profile of the new Executor and no conversation,
   * and the next go opens a session with the package as its prompt (`executing`). The attempt is
   * the same (same id, same worktree and branch, same `attempt + step` keys of the effects), so no
   * attempt of the demand is spent and `resume.max_resumes` is not touched. The Executor that
   * gives the baton never gets it back: it stays in `context.used`.
   */
  async #handoff(
    context: AttemptContext,
    decision: InterruptionDecision,
    ready: Extract<Prepared, { kind: 'ready' }>,
  ): Promise<Step> {
    const { journal } = context;
    const { target } = ready;
    const from = this.#executor(context);
    const fromId = this.#executorId(context);
    const previousSessionId = context.sessionId;
    await journal.write(undefined, { state: 'awaiting_resume', cause: decision.cause });
    context.spec = retarget(context.spec, target);
    context.used.push(target.executorId);
    context.sessionId = undefined;
    context.handoffPrompt = ready.prompt;
    // The counters of the allowance belong to the Executor that stopped.
    context.lastError = undefined;
    context.crashes = 0;
    context.handoffs.push({
      cause: decision.cause,
      from: fromId,
      to: target.executorId,
      previousSessionId,
      countedAsAttempt: decision.countsAsAttempt,
      packageChars: ready.prompt.length,
      packageLevel: ready.level,
      packageCut: ready.cut,
      summary: ready.summary,
      summaryError: ready.summaryError,
    });
    // No conversation is left to reload: a restart now finds an attempt with no session.
    await journal.write(undefined, {
      state: 'resuming',
      client: target.profile.client,
      profile: target.profile.profile,
      sessionId: null,
    });
    if (ready.selection !== undefined) {
      await journal.write(
        buildDaemonEvent(
          'executor.selected',
          executorSelectedPayload(ready.selection, {
            playId: context.spec.playId,
            now: this.#options.clock.now(),
          }),
        ),
      );
    }
    // The event of the baton is the hook for plugins; the chat message below is for people.
    await journal.write(
      buildDaemonEvent('session.handoff', {
        ...(previousSessionId === undefined ? {} : { previousSessionId }),
        ...(context.spec.role === undefined ? {} : { role: context.spec.role }),
        cause: decision.cause,
        from,
        to: executorPayloadOf(target),
        countedAsAttempt: decision.countsAsAttempt,
        packageChars: ready.prompt.length,
        packageLevel: ready.level,
        packageCut: ready.cut,
        summary: ready.summary,
        ...(ready.summaryError === undefined ? {} : { summaryError: ready.summaryError }),
        ...this.#correlation(context),
      }),
    );
    await this.#announceHandoff(context, {
      cause: decision.cause,
      fromExecutor: fromId,
      toExecutor: target.executorId,
    });
    return {
      resumeSessionId: undefined,
      prompt: ready.prompt,
      cause: decision.cause,
      handoff: { previousSessionId, from },
    };
  }

  /**
   * `session.handoff_failed`: the policy chose a handoff and nobody took it (the attempt is parked
   * right after). The reason and the wait are the ones of `AttemptOutcome.handoffWait`. The values
   * are cut to what the schema accepts, so an odd port cannot stop the attempt with its answer.
   */
  async #handoffFailed(
    context: AttemptContext,
    decision: InterruptionDecision,
    wait: HandoffWait,
  ): Promise<void> {
    const { sessionId, spec } = context;
    await context.journal.write(
      buildDaemonEvent('session.handoff_failed', {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(spec.role === undefined ? {} : { role: spec.role }),
        cause: decision.cause,
        from: this.#executor(context),
        reason: wait.reason.slice(0, 64) || 'unknown',
        on: wait.on.map((executor) => executor.slice(0, 256)),
        until: wait.until === null ? null : Math.max(0, Math.trunc(wait.until)),
        ...(wait.error === undefined ? {} : { error: wait.error }),
        ...this.#correlation(context),
      }),
    );
  }

  /**
   * The system message of the handoff for the chat of the scenario: one `scenario.system_message`
   * in the log and the same payload to the port, which shows it. It never stops the handoff.
   */
  async #announceHandoff(
    context: AttemptContext,
    facts: { cause: string; fromExecutor: string; toExecutor: string },
  ): Promise<void> {
    const { store, logger, handoff } = this.#options;
    const { spec } = context;
    try {
      const play = await store.plays.get(spec.playId);
      if (play === undefined) return;
      const notice: ScenarioHandoffNotice = {
        scenarioId: play.scenarioId,
        kind: 'handoff',
        playId: spec.playId,
        attemptId: context.attemptId,
        role: spec.role ?? null,
        ...facts,
      };
      await store.events.append({
        ...buildDaemonEvent('scenario.system_message', notice),
        scenarioId: play.scenarioId,
      });
      handoff?.announce?.(notice);
    } catch (error) {
      logger.warn({ err: error, attemptId: context.attemptId }, 'the handoff message was not sent');
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
    to?: HandoffTarget,
  ): Promise<void> {
    await this.#interruptionEvent(context, decision, ended.detail, ended.sha, signals, to);
    await this.#closed(context, 'interrupted', { state: 'interrupted', cause: decision.cause });
  }

  /**
   * `session.interrupted` and the row of `interruptions`, in one transaction: the event carries the
   * cause (and the reset time, when known), the row what the policy decided. Both need an opened
   * session; an error before any session existed leaves neither. The event says the form the
   * policy chose and the Executors: `from` is the one that stopped, `to` the one the work goes to
   * (the same one for a native resume, the chosen one for a handoff; absent when it is not known).
   */
  async #interruptionEvent(
    context: AttemptContext,
    decision: InterruptionDecision,
    detail: string,
    sha: string | undefined,
    signals: readonly string[],
    target?: HandoffTarget,
  ): Promise<void> {
    const { sessionId, sessionOpen, spec } = context;
    if (sessionId === undefined) return;
    if (!sessionOpen) {
      // The conversation never opened (a native reload that failed): its row, written when the
      // session dropped, said `native`; the baton changes it to what really happened.
      if (target === undefined) return;
      const last = (await this.#options.store.interruptions.list({ sessionId })).at(-1);
      if (last === undefined) return;
      await this.#options.store.interruptions.update(last.id, {
        resumeForm: 'handoff',
        toExecutor: target.executorId,
        countedAsAttempt: decision.countsAsAttempt,
        signals: [...last.signals, `action:${decision.action}`],
      });
      return;
    }
    const to =
      target === undefined
        ? decision.form === 'native'
          ? this.#executor(context)
          : undefined
        : executorPayloadOf(target);
    await context.journal.write(
      buildDaemonEvent('session.interrupted', {
        sessionId,
        cause: decision.cause,
        detail,
        ...(decision.form === null ? {} : { form: decision.form }),
        from: this.#executor(context),
        ...(to === undefined ? {} : { to }),
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
        toExecutor: target?.executorId ?? null,
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
  async #stopped(
    context: AttemptContext,
    sha: string | undefined,
    leaving = false,
  ): Promise<AttemptOutcome> {
    const decision = {
      ...decideInterruption(this.#facts(context, 'daemon_restart'), this.#rules()),
      form: null,
    };
    await this.#interruptionEvent(
      context,
      decision,
      leaving ? 'the profile of the session was removed (drain: force)' : 'the daemon stopped',
      sha ?? context.journal.record.lastCheckpoint ?? undefined,
      [leaving ? 'profile:leaving' : 'daemon:stopping', `action:${decision.action}`],
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
  async #parked(
    context: AttemptContext,
    decision: InterruptionDecision,
    wait?: HandoffWait,
  ): Promise<AttemptOutcome> {
    await context.journal.write(undefined, { state: 'interrupted', cause: decision.cause });
    await context.journal.flush();
    return this.#outcome(context, 'interrupted', decision.cause, undefined, true, decision, wait);
  }

  #outcome(
    context: AttemptContext,
    state: AttemptResultState,
    cause: string | undefined,
    stopReason: StopReason | undefined,
    needsDecision: boolean,
    decision?: InterruptionDecision,
    handoffWait?: HandoffWait,
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
      handoffs: [...context.handoffs],
      handoffWait,
    };
  }
}

/** The go ended because its profile left (P21). */
function isLeaving(ended: Ended): boolean {
  return (ended.kind === 'interrupted' || ended.kind === 'stopped') && ended.leaving === true;
}

/** The wait an attempt is left with when the policy chose a handoff and the runner has no port for it. */
function noHandoffPort(decision: InterruptionDecision): HandoffWait | undefined {
  return decision.action === 'handoff' ? { reason: 'no_port', on: [], until: null } : undefined;
}

function executorPayloadOf(target: HandoffTarget): ExecutorPayload {
  const { profile, executor } = target;
  return {
    client: profile.client,
    profile: profile.profile,
    model: executor.model,
    ...(executor.effort === undefined ? {} : { effort: executor.effort }),
    ...(executor.mode === undefined ? {} : { mode: executor.mode }),
  };
}

/** The spec of the attempt with the Executor of the handoff in place of the one that stopped. */
function retarget(spec: AttemptContext['spec'], target: HandoffTarget): AttemptContext['spec'] {
  return {
    playId: spec.playId,
    demandId: spec.demandId,
    attempt: spec.attempt,
    ...(spec.role === undefined ? {} : { role: spec.role }),
    ...(spec.base === undefined ? {} : { base: spec.base }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    profile: target.profile,
    executor: target.executor,
    policy: target.policy,
    ...(target.whenExhausted === undefined ? {} : { whenExhausted: target.whenExhausted }),
    ...(target.inFlight === undefined ? {} : { inFlight: target.inFlight }),
  };
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
