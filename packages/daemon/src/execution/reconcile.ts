// SPDX-License-Identifier: MPL-2.0
import { attemptInputOf, type AttemptRecord, type Store } from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import type { Logger } from '../logger.js';
import type { AttemptOutcome, AttemptRunner, ResumeContext } from './attempt-runner.js';

/**
 * Tells the runner what it needs to resume an attempt it did not start: the profile, the Executor
 * and the policy of the role. The registry keeps only ids, because the roles belong to the
 * Director; `undefined` means "I do not know this attempt" and it is parked for a decision.
 */
export type AttemptResolver = (
  record: AttemptRecord,
) => ResumeContext | undefined | Promise<ResumeContext | undefined>;

/**
 * Whether an attempt the resolver did not take is kept for its play (`resume.on_restart: native`):
 * it is left as it is, for the play to resume it when it runs the stage or the demand again.
 */
export type AttemptDeferral = (record: AttemptRecord) => boolean | Promise<boolean>;

export interface ReconcileOptions {
  readonly store: Store;
  readonly runner: AttemptRunner;
  readonly resolver: AttemptResolver | undefined;
  /** Absent: nothing is kept for the plays, and what the resolver does not know is parked. */
  readonly defer?: AttemptDeferral | undefined;
  readonly logger: Logger;
}

export interface ReconcileReport {
  /** Attempts that were in progress when the daemon stopped. */
  readonly found: readonly string[];
  /** Attempts whose conversation is being reloaded (`session/load`). */
  readonly resuming: readonly string[];
  /** Attempts the resolver did not know: parked as `interrupted` for a decision. */
  readonly parked: readonly string[];
  /**
   * Attempts kept for their play (`resume.on_restart: native`), untouched: the play resumes each
   * one when it runs its stage or demand again, or parks it when it cannot.
   */
  readonly deferred: readonly AttemptRecord[];
  /** Settles when every resumed attempt has ended; it never rejects. */
  readonly done: Promise<readonly AttemptOutcome[]>;
}

/** States of an attempt a running daemon owns; `interrupted` is parked and not picked up. */
const IN_PROGRESS = ['executing', 'resuming', 'awaiting_resume'] as const;

/**
 * Reconciliation at start (architecture 5.21): the attempts the store says were running belong to
 * a daemon that no longer exists. Each one is resumed natively when the resolver knows it
 * (`session/load` of its conversation, after a WIP commit of what the worktree holds), and parked
 * as `interrupted` with the cause `daemon_restart` when it does not. This returns as soon as the
 * resumes have started; `done` is for whoever waits for them.
 */
export async function reconcileAttempts(options: ReconcileOptions): Promise<ReconcileReport> {
  const { store, runner, resolver, defer, logger } = options;
  const records = await store.attempts.list({ states: IN_PROGRESS });
  const resuming: string[] = [];
  const parked: string[] = [];
  const deferred: AttemptRecord[] = [];
  const running: Promise<AttemptOutcome | undefined>[] = [];
  for (const record of records) {
    if (record.state === 'awaiting_resume' && record.cause === 'paused') {
      // A pause (N176) lives in the memory of the runner: after a restart nothing waits to wake it.
      // `session.interrupted` and the interruption row were written when it paused, so this only
      // parks the state; whoever resumes the play opens the demand again.
      await store.attempts.put({
        ...attemptInputOf(record),
        state: 'interrupted',
        cause: 'paused',
      });
      parked.push(record.attemptId);
      continue;
    }
    const resolved = resolver === undefined ? undefined : await resolver(record);
    if (resolved === undefined && defer !== undefined && (await defer(record))) {
      deferred.push(record);
      continue;
    }
    if (resolved === undefined) {
      await parkAttempt(store, record);
      parked.push(record.attemptId);
      continue;
    }
    resuming.push(record.attemptId);
    running.push(
      runner.resume(record, resolved).catch((error: unknown) => {
        logger.error({ err: error, attemptId: record.attemptId }, 'resuming an attempt failed');
        return undefined;
      }),
    );
  }
  logger.info(
    {
      found: records.length,
      resuming: resuming.length,
      parked: parked.length,
      deferred: deferred.length,
    },
    'attempts reconciled',
  );
  return {
    found: records.map((record) => record.attemptId),
    resuming,
    parked,
    deferred,
    done: Promise.all(running).then((all) =>
      all.filter((outcome): outcome is AttemptOutcome => outcome !== undefined),
    ),
  };
}

/**
 * Parks an attempt no one resumes: `session.interrupted`, the interruption row with the form
 * `handoff`, and the state `interrupted` (cause `daemon_restart`, or `profile_removed` kept).
 * `signals` adds why on top of `action:handoff`; the default is `resolver:unknown`.
 */
export async function parkAttempt(
  store: Store,
  record: AttemptRecord,
  reason: { readonly signal?: string; readonly detail?: string } = {},
): Promise<void> {
  // A profile that was removed (`drain.on_timeout: force`, P21b) keeps its cause: the attempt does not
  // wait for a restart of the daemon, it waits for another Executor.
  const cause = record.cause === 'profile_removed' ? 'profile_removed' : 'daemon_restart';
  await store.transaction(async (tx) => {
    if (record.sessionId !== null) {
      await tx.events.append({
        ...buildDaemonEvent('session.interrupted', {
          sessionId: record.sessionId,
          cause,
          detail:
            reason.detail ??
            (cause === 'profile_removed'
              ? 'the profile of the session was removed and nothing knows how to resume this attempt'
              : 'the daemon was not running and nothing knows how to resume this attempt'),
          ...(record.lastCheckpoint === null ? {} : { checkpointSha: record.lastCheckpoint }),
          playId: record.playId,
          demandId: record.demandId,
          attemptId: record.attemptId,
        }),
        playId: record.playId,
        attemptId: record.attemptId,
      });
      // Nothing knows the Executor, so nothing can reload the conversation: the way on is a handoff
      // (5.16). A restart is no failure of the agent, so it costs no attempt.
      const signals = [reason.signal ?? 'resolver:unknown', 'action:handoff'];
      const rows = await tx.interruptions.list({
        sessionId: record.sessionId,
        causes: [cause],
      });
      const open = rows.filter((row) => row.resumeForm === null).at(-1);
      if (open === undefined) {
        await tx.interruptions.create({
          sessionId: record.sessionId,
          playId: record.playId,
          cause,
          signals,
          resumeForm: 'handoff',
          countedAsAttempt: false,
        });
      } else {
        await tx.interruptions.update(open.id, {
          resumeForm: 'handoff',
          signals: [...open.signals, ...signals],
        });
      }
    }
    await tx.attempts.put({
      ...attemptInputOf(record),
      state: 'interrupted',
      cause,
    });
  });
}
