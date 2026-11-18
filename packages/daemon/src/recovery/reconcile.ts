// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  supportsHistory,
  supportsOrphanKill,
  type CodeHost,
  type JsonObject,
  type ProcessLauncher,
  type SideEffectRecord,
  type Store,
  type Vcs,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import { DECISION_KINDS } from '../orchestration/play-effects.js';
import type { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import { COMMAND_EFFECTS, verifyCommand, verifySideEffect } from '../workspace/verifiers.js';

/** First line of the commit that keeps what a worktree held when the daemon died. */
export const RECOVERY_COMMIT_PREFIX = 'wip(recovery): ';

/** The states of a session or an attempt that belong to a daemon that is running. */
const LIVE_SESSION_STATES = ['active', 'resuming', 'awaiting_resume'] as const;
const LIVE_ATTEMPT_STATES = ['executing', 'resuming', 'awaiting_resume'] as const;

export interface RecoveryDeps {
  readonly store: Store;
  readonly vcs: Vcs;
  /** Without it no effect of the workspace can be verified: each one is left to the Producer. */
  readonly codeHost: CodeHost | undefined;
  /** Without the orphan capability the client processes of the dead daemon are left alone. */
  readonly launcher: ProcessLauncher | undefined;
  readonly logger: Logger;
  /** The verifiers of the effects of plugins (P22 hook); none by default. */
  readonly pluginEffects?: PluginEffectRegistry | undefined;
}

/** An effect nobody could settle: it waits for the Producer. */
export interface PendingEffect {
  readonly key: string;
  readonly effectType: string;
  readonly playId: string | null;
  readonly reason: string;
}

/** An effect the verifier settled from outside. */
export interface ResolvedEffect {
  readonly key: string;
  readonly effectType: string;
  readonly playId: string | null;
  readonly outcome: 'done' | 'not_done';
}

/** What the part of the reconciliation that runs before anything is resumed found and did. */
export interface RecoveryReport {
  readonly orphansKilled: number;
  readonly sessionsInterrupted: number;
  readonly wipCommits: number;
  readonly effectsResolved: number;
  /** The effects counted in `effectsResolved`, one by one (for the notice of each scenario). */
  readonly resolved: readonly ResolvedEffect[];
  readonly pending: readonly PendingEffect[];
}

/**
 * Reconciliation at start (architecture 5.21, steps 2 to 5), before any attempt or play is
 * resumed:
 * 1. the client processes the dead daemon left are ended, found by pid AND start instant, so a pid
 *    the system recycled is never signalled;
 * 2. the sessions that were live become `interrupted`;
 * 3. what the worktrees of the attempts in progress hold uncommitted becomes a `wip(recovery)`
 *    commit;
 * 4. each effect with an intent and no end is checked by its verifier: found done or not done, it
 *    is settled; otherwise it stays `ambiguous` and the Producer is asked (`recovery_effect`
 *    decision, idempotent per effect), and the play stays where it is.
 * A step that fails is logged and does not stop the next ones; what it left undone is found again
 * by the next start.
 */
export async function reconcileBeforeResume(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { logger } = deps;
  const orphans = await endOrphans(deps);
  const wipCommits = await keepUncommittedWork(deps).catch((error: unknown) => {
    logger.error({ err: error }, 'recovery: the work left in the worktrees could not be kept');
    return 0;
  });
  const effects = await settleEffects(deps).catch((error: unknown) => {
    logger.error({ err: error }, 'recovery: the side effects could not be settled');
    return { resolved: [] as ResolvedEffect[], pending: [] as PendingEffect[] };
  });
  logger.info(
    {
      orphansKilled: orphans.killed,
      sessionsInterrupted: orphans.interrupted,
      wipCommits,
      effectsResolved: effects.resolved.length,
      pending: effects.pending.length,
    },
    'recovery before the resume done',
  );
  return {
    orphansKilled: orphans.killed,
    sessionsInterrupted: orphans.interrupted,
    wipCommits,
    effectsResolved: effects.resolved.length,
    resolved: effects.resolved,
    pending: effects.pending,
  };
}

async function endOrphans(deps: RecoveryDeps): Promise<{ killed: number; interrupted: number }> {
  const { store, launcher, logger } = deps;
  const rows = await store.sessions.list({ states: LIVE_SESSION_STATES });
  let killed = 0;
  let interrupted = 0;
  for (const row of rows) {
    if (
      row.pid !== null &&
      row.processStartedAt !== null &&
      launcher !== undefined &&
      supportsOrphanKill(launcher)
    ) {
      try {
        const result = await launcher.killOrphan({
          pid: row.pid,
          startedAt: row.processStartedAt,
        });
        if (result.matched) killed += 1;
      } catch (error) {
        // The process may still be there: the row stays live and the next start tries again.
        logger.error({ err: error, sessionId: row.id }, 'recovery: an orphan could not be ended');
        continue;
      }
    }
    try {
      await store.sessions.update(row.id, { state: 'interrupted' });
      interrupted += 1;
    } catch (error) {
      logger.error({ err: error, sessionId: row.id }, 'recovery: a session could not be parked');
    }
  }
  return { killed, interrupted };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function keepUncommittedWork(deps: RecoveryDeps): Promise<number> {
  const { store, vcs, logger } = deps;
  let commits = 0;
  const attempts = await store.attempts.list({ states: LIVE_ATTEMPT_STATES });
  for (const attempt of attempts) {
    if (!(await exists(attempt.worktree))) continue;
    try {
      const sha = await vcs.commitAll(
        attempt.worktree,
        `${RECOVERY_COMMIT_PREFIX}work of ${attempt.attemptId} left by a stopped daemon`,
      );
      if (sha !== undefined) commits += 1;
    } catch (error) {
      logger.error(
        { err: error, attemptId: attempt.attemptId },
        'recovery: a worktree could not be committed',
      );
    }
  }
  return commits;
}

/** The open play whose id starts the idempotency key (`<playId>:push:...`), if there is one. */
function playOfKey(key: string, openPlays: readonly { id: string; scenarioId: string }[]) {
  return openPlays.find((play) => key.startsWith(`${play.id}:`));
}

/** [proposta] The id of the question about one effect: stable, so a second start asks nothing new. */
export function recoveryDecisionId(playId: string, key: string): string {
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `${playId}:recovery:${digest}`;
}

async function settleEffects(
  deps: RecoveryDeps,
): Promise<{ resolved: ResolvedEffect[]; pending: PendingEffect[] }> {
  const { store, vcs, codeHost, logger } = deps;
  const records = await store.sideEffects.list({ states: ['pending', 'ambiguous'] });
  const openPlays = await store.plays.list({ open: true });
  const verifierDeps =
    codeHost !== undefined && supportsHistory(vcs) ? { vcs, codeHost } : undefined;
  const resolved: ResolvedEffect[] = [];
  const pending: PendingEffect[] = [];
  for (const record of records) {
    const play = playOfKey(record.idempotencyKey, openPlays);
    const verdict = await verdictOf(verifierDeps, record, deps.pluginEffects);
    if (verdict.verdict === 'done') {
      await store.sideEffects.resolve(record.idempotencyKey, {
        state: 'done',
        result: verdict.result,
        verifier: 'verifier',
      });
      resolved.push({
        key: record.idempotencyKey,
        effectType: record.type,
        playId: play?.id ?? null,
        outcome: 'done',
      });
      continue;
    }
    if (verdict.verdict === 'not_done') {
      await store.sideEffects.resolve(record.idempotencyKey, {
        state: 'not_done',
        verifier: 'verifier',
      });
      resolved.push({
        key: record.idempotencyKey,
        effectType: record.type,
        playId: play?.id ?? null,
        outcome: 'not_done',
      });
      continue;
    }
    if (record.state === 'pending') {
      await store.sideEffects.resolve(record.idempotencyKey, {
        state: 'ambiguous',
        verifier: null,
      });
    }
    pending.push({
      key: record.idempotencyKey,
      effectType: record.type,
      playId: play?.id ?? null,
      reason: verdict.reason,
    });
    if (play === undefined) continue;
    const id = recoveryDecisionId(play.id, record.idempotencyKey);
    if ((await store.decisions.get(id)) !== undefined) continue;
    await store.decisions.create({
      id,
      scenarioId: play.scenarioId,
      playId: play.id,
      kind: DECISION_KINDS.recovery,
      input: recoveryQuestion(record, verdict.reason),
    });
    logger.warn(
      { playId: play.id, key: record.idempotencyKey },
      'recovery: an effect could not be settled; the Producer is asked',
    );
  }
  return { resolved, pending };
}

async function verdictOf(
  verifierDeps: Parameters<typeof verifySideEffect>[0] | undefined,
  record: SideEffectRecord,
  plugins?: PluginEffectRegistry,
): ReturnType<typeof verifySideEffect> {
  // An effect a plugin declared is judged by the verifier of the plugin.
  const ofPlugin = await plugins?.verify(record);
  if (ofPlugin !== undefined) return ofPlugin;
  // The commands of the worktree are judged by their own record, with no code host (P22).
  if (COMMAND_EFFECTS.includes(record.type)) return verifyCommand(record);
  if (verifierDeps === undefined) {
    return { verdict: 'ambiguous', reason: 'There is no code host to check the effect against' };
  }
  try {
    return await verifySideEffect(verifierDeps, record);
  } catch (error) {
    return {
      verdict: 'ambiguous',
      reason: `The verifier failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The input of the question: `options` and `reason` are what the chat shows (it treats this kind
 * like the menu). [proposta]
 */
function recoveryQuestion(record: SideEffectRecord, reason: string): JsonObject {
  return {
    key: record.idempotencyKey,
    effectType: record.type,
    target: record.target,
    reason: `The effect ${record.type} on ${record.target} started and has no end record: ${reason}`,
    options: ['not_done', 'done'],
  };
}
