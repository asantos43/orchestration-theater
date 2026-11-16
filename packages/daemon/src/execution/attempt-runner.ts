// SPDX-License-Identifier: MPL-2.0
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  attemptBranch,
  attemptInputOf,
  Cancelled,
  hasErrorCode,
  type AttemptRecord,
  type AttemptRecordInput,
  type Clock,
  type ExecutorConfig,
  type NormalizedUpdate,
  type Profile,
  type RolePolicy,
  type StopReason,
  type Store,
  type Vcs,
} from '@otheater/core';
import { buildDaemonEvent, type ExecutorPayload, type InterruptionCause } from '@otheater/protocol';
import { CheckpointTracker } from './checkpoints.js';
import { AttemptJournal, type AttemptPatch } from './journal.js';
import type { SessionLease, SessionPool } from './pool.js';
import type { ExecutionSettings } from './settings.js';
import type { Logger } from '../logger.js';

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
  /** Overrides `limits.demand_timeout`; never above `limits.demand_timeout_max`. */
  readonly timeoutMs?: number;
}

/** What the daemon must know again to resume an attempt it did not start (reconciliation). */
export interface ResumeContext {
  readonly profile: Profile;
  readonly executor: ExecutorConfig;
  readonly policy: RolePolicy;
  readonly timeoutMs?: number;
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
  /**
   * Free resumes granted so far (see `Ended.free`). [proposta] Kept in memory: a restart of the
   * daemon starts the count again, because the attempt registry has no column for it.
   */
  freeResumes: number;
  /** `session.opened` was recorded and `session.closed` was not yet. */
  sessionOpen: boolean;
  lease: SessionLease | undefined;
  lastEventAt: number;
  lastError: { key: string; count: number } | undefined;
}

const NEVER: Promise<never> = new Promise<never>(() => undefined);

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
 * - A crash of the client, a transient error or a restart of the daemon resume the same
 *   conversation (`session/load`), with an exponential wait for the transient errors and
 *   `resume.max_resumes` as the limit. [proposta] The causes that need another Executor or a
 *   person (quota, refusal, permission, stuck) park the attempt as `interrupted` with
 *   `needsDecision`, because the handoff belongs to the Director.
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
    if (missing !== undefined) {
      await context.journal.write(undefined, { state: 'interrupted', cause: missing });
      await context.journal.flush();
      return this.#outcome(context, 'interrupted', missing, undefined, true);
    }
    // A daemon that was killed left no trace of the interruption: record it now, and commit what
    // the Executor had written (a graceful stop did both already).
    if (record.state !== 'awaiting_resume') {
      context.sessionOpen = true;
      const sha = await this.#checkpoint(context, 'daemon_restart');
      await this.#interruptionEvent(context, 'daemon_restart', 'the daemon was not running', sha);
      await this.#closed(context, 'interrupted', { state: 'resuming', cause: 'daemon_restart' });
    }
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
      freeResumes: 0,
      sessionOpen: false,
      lease: undefined,
      lastEventAt: clock.now(),
      lastError: undefined,
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
          await this.#interrupted(context, ended);
          // A casualty of another session's cancel resumes free of `max_resumes`, up to
          // `resume.max_free_resumes` times per attempt; past that it is a drop like any other.
          const free = ended.free === true && context.freeResumes < settings.maxFreeResumes;
          const sameTimes = free ? 0 : this.#repeated(context, `${ended.cause}:${ended.detail}`);
          const resumes = journal.record.resumes;
          if (!ended.native || (!free && resumes >= settings.maxResumes)) {
            return this.#parked(context, ended.cause);
          }
          if (sameTimes >= settings.stuckSameErrorTimes) {
            return this.#parked(context, 'stuck');
          }
          if (free) context.freeResumes += 1;
          await journal.write(undefined, { state: 'awaiting_resume', cause: ended.cause });
          const waited = await this.#backoff(context, ended.cause, free ? 0 : resumes);
          if (waited === 'timeout') return this.#timedOut(context, ended.sha);
          if (waited === 'stopped') return this.#stopped(context, ended.sha);
          await journal.write(undefined, {
            state: 'resuming',
            resumes: free ? resumes : resumes + 1,
          });
          step = {
            resumeSessionId: context.sessionId,
            prompt: context.sessionId === undefined ? context.firstPrompt : settings.continuePrompt,
            cause: ended.cause,
          };
        }
      }
    }
  }

  /** One go: a session from the pool, the prompt, and the end of that session. */
  async #once(context: AttemptContext, step: Step): Promise<Ended> {
    const { pool } = this.#options;
    const { spec } = context;
    let lease: SessionLease;
    try {
      lease = await pool.acquire({
        client: spec.profile.client,
        profile: spec.profile,
        policy: spec.policy,
        cwd: context.worktree,
        ...(step.resumeSessionId === undefined ? {} : { resumeSessionId: step.resumeSessionId }),
        signal: context.stop.signal,
      });
    } catch (error) {
      if (context.stop.signal.aborted && hasErrorCode(error, 'CANCELLED')) {
        return { kind: 'stopped', sha: await this.#checkpoint(context, 'stopped') };
      }
      return this.#classify(error, step.resumeSessionId !== undefined);
    }
    context.lease = lease;
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
    }
    await context.tracker.settled();
    ended = this.#casualty(lease, ended);
    ended = await this.#beforeClosing(context, lease, ended);
    await lease.release().catch(() => undefined);
    context.lease = undefined;
    return ended;
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
    } catch (error) {
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
      const now = context.journal.touch();
      context.lastEventAt = now;
      void context.journal.write(
        buildDaemonEvent('session.update', {
          sessionId,
          update,
          ...this.#correlation(context),
        }),
        { lastEventAt: now },
      );
      context.tracker.observe(update);
    } catch (error) {
      this.#options.logger.warn(
        { err: error, attemptId: context.attemptId },
        'update not recorded',
      );
    }
  }

  // ---- errors ----

  /** The policy by cause of architecture 5.16: what can be resumed in place and what cannot. */
  #classify(error: unknown, resuming: boolean): Ended {
    const detail = describe(error);
    const interrupted = (cause: InterruptionCause, native: boolean, kill: boolean): Ended => ({
      kind: 'interrupted',
      cause,
      detail,
      native,
      kill,
      sha: undefined,
    });
    if (hasErrorCode(error, 'TRANSIENT')) return interrupted('transient', true, false);
    if (hasErrorCode(error, 'ADAPTER_UNAVAILABLE')) return interrupted('client_crash', true, true);
    if (hasErrorCode(error, 'QUOTA_EXHAUSTED')) return interrupted('quota_exhausted', false, false);
    if (hasErrorCode(error, 'PERMISSION_DENIED')) return interrupted('permission', false, false);
    if (resuming && hasErrorCode(error, 'NOT_FOUND')) {
      // `session/load` of a conversation the client no longer has: only a handoff continues.
      return interrupted('client_crash', false, false);
    }
    return { kind: 'failed', message: detail };
  }

  /** How many times in a row the same interruption came up. */
  #repeated(context: AttemptContext, key: string): number {
    const count = context.lastError?.key === key ? context.lastError.count + 1 : 1;
    context.lastError = { key, count };
    return count;
  }

  /** The wait before a native resume: exponential for a transient error, none for a crash. */
  async #backoff(
    context: AttemptContext,
    cause: InterruptionCause,
    resumes: number,
  ): Promise<'ok' | 'timeout' | 'stopped'> {
    const { settings, clock } = this.#options;
    const list = settings.transientBackoffMs;
    const ms =
      cause === 'transient' && list.length > 0
        ? (list[Math.min(resumes, list.length - 1)] ?? 0)
        : 0;
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
  ): Promise<void> {
    await this.#interruptionEvent(context, ended.cause, ended.detail, ended.sha);
    await this.#closed(context, 'interrupted', { state: 'interrupted', cause: ended.cause });
  }

  async #interruptionEvent(
    context: AttemptContext,
    cause: InterruptionCause,
    detail: string,
    sha: string | undefined,
  ): Promise<void> {
    const { sessionId, sessionOpen } = context;
    if (sessionId === undefined || !sessionOpen) return;
    await context.journal.write(
      buildDaemonEvent('session.interrupted', {
        sessionId,
        cause,
        detail,
        ...(sha === undefined ? {} : { checkpointSha: sha }),
        ...this.#correlation(context),
      }),
    );
  }

  async #finished(context: AttemptContext, stopReason: StopReason): Promise<AttemptOutcome> {
    await this.#closed(context, 'completed', { state: 'completed', cause: null });
    await context.journal.flush();
    return this.#outcome(context, 'completed', undefined, stopReason, false);
  }

  async #failed(context: AttemptContext, message: string): Promise<AttemptOutcome> {
    await this.#closed(context, 'failed', { state: 'failed', cause: message });
    await context.journal.flush();
    return this.#outcome(context, 'failed', message, undefined, false);
  }

  async #timedOut(context: AttemptContext, sha: string | undefined): Promise<AttemptOutcome> {
    await this.#interruptionEvent(
      context,
      'timeout',
      'the attempt reached its deadline',
      sha ?? context.journal.record.lastCheckpoint ?? undefined,
    );
    await this.#closed(context, 'interrupted', { state: 'timed_out', cause: 'timeout' });
    await context.journal.flush();
    return this.#outcome(context, 'timed_out', 'timeout', undefined, true);
  }

  async #stopped(context: AttemptContext, sha: string | undefined): Promise<AttemptOutcome> {
    await this.#interruptionEvent(
      context,
      'daemon_restart',
      'the daemon stopped',
      sha ?? context.journal.record.lastCheckpoint ?? undefined,
    );
    await this.#closed(context, 'interrupted', {
      state: 'awaiting_resume',
      cause: 'daemon_restart',
    });
    await context.journal.flush();
    return this.#outcome(context, 'interrupted', 'daemon_restart', undefined, false);
  }

  /** Stopped for a cause only a decision resolves; the registry keeps it as `interrupted`. */
  async #parked(context: AttemptContext, cause: InterruptionCause): Promise<AttemptOutcome> {
    await context.journal.write(undefined, { state: 'interrupted', cause });
    await context.journal.flush();
    return this.#outcome(context, 'interrupted', cause, undefined, true);
  }

  #outcome(
    context: AttemptContext,
    state: AttemptResultState,
    cause: string | undefined,
    stopReason: StopReason | undefined,
    needsDecision: boolean,
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
