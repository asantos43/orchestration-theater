// SPDX-License-Identifier: MPL-2.0
import type { Store } from '@otheater/core';
import {
  buildDaemonEvent,
  type ScenarioRecoveryNotice,
  type ScenarioSystemMessagePayload,
} from '@otheater/protocol';
import type { RecoveryNoticeMode } from '../config.js';
import type { Logger } from '../logger.js';
import type { RecoveryReport } from './reconcile.js';

export interface RecoveryNoticeInput {
  readonly store: Pick<Store, 'attempts' | 'events' | 'plays'>;
  readonly logger: Logger;
  /** `recovery.notice`: `always`, `unclean_only` or `off`. */
  readonly mode: RecoveryNoticeMode;
  /** The part of the reconciliation that runs before the resume. */
  readonly recovery: RecoveryReport;
  /** The plays the runner restored from their snapshots, and the ones it could not. */
  readonly plays: { readonly resumed: readonly string[]; readonly refused: readonly string[] };
  /** The attempts whose conversation is being reloaded. */
  readonly attempts: { readonly resuming: readonly string[] };
}

type Draft = {
  -readonly [K in 'resumed' | 'settled' | 'waiting']: ScenarioRecoveryNotice[K];
};

/**
 * The message of the reconciliation for the chat of each scenario it touched (architecture 5.21,
 * step 8). [proposta] A scenario is touched when something of it was taken up again (a play or an
 * attempt), settled by a verifier, or left waiting for the Producer (an effect nobody could check,
 * a play that could not be restored). An attempt parked as interrupted is not said: its play goes
 * on and does the work again, so it waits for nobody (`daemon.recovered` counts it). Everything is
 * attributed to a scenario through its play; an effect or an attempt of no known play is only in
 * `daemon.recovered`. A start that found nothing of the kind returns an empty list and writes
 * nothing. The mode `recovery.notice` narrows it: `unclean_only` skips a scenario with only
 * resumes, `off` skips all.
 *
 * One `scenario.system_message` event is written for each scenario touched (the record), and the
 * payloads are returned for the Producer channel to show. A message that cannot be written is
 * logged and skipped: it must never stop the start-up.
 */
export async function announceRecovery(
  input: RecoveryNoticeInput,
): Promise<readonly ScenarioSystemMessagePayload[]> {
  const { store, logger } = input;
  if (input.mode === 'off') return [];
  const drafts = new Map<string, Draft>();
  const scenarioCache = new Map<string, string | undefined>();

  const scenarioOfPlay = async (playId: string): Promise<string | undefined> => {
    if (!scenarioCache.has(playId)) {
      scenarioCache.set(playId, (await store.plays.get(playId))?.scenarioId);
    }
    return scenarioCache.get(playId);
  };
  const draftOf = (scenarioId: string): Draft => {
    let draft = drafts.get(scenarioId);
    if (draft === undefined) {
      draft = { resumed: [], settled: [], waiting: [] };
      drafts.set(scenarioId, draft);
    }
    return draft;
  };
  /** The scenario of an attempt, through its play, when the store knows it. */
  const scenarioOfAttempt = async (attemptId: string): Promise<string | undefined> => {
    const attempt = await store.attempts.get(attemptId);
    return attempt === undefined ? undefined : scenarioOfPlay(attempt.playId);
  };

  try {
    for (const id of input.plays.resumed) {
      const scenarioId = await scenarioOfPlay(id);
      if (scenarioId !== undefined) draftOf(scenarioId).resumed.push({ kind: 'play', id });
    }
    for (const id of input.attempts.resuming) {
      const scenarioId = await scenarioOfAttempt(id);
      if (scenarioId !== undefined) draftOf(scenarioId).resumed.push({ kind: 'attempt', id });
    }
    for (const effect of input.recovery.resolved) {
      if (effect.playId === null) continue;
      const scenarioId = await scenarioOfPlay(effect.playId);
      if (scenarioId === undefined) continue;
      draftOf(scenarioId).settled.push({
        effectType: effect.effectType,
        playId: effect.playId,
        outcome: effect.outcome,
      });
    }
    for (const effect of input.recovery.pending) {
      if (effect.playId === null) continue;
      const scenarioId = await scenarioOfPlay(effect.playId);
      if (scenarioId === undefined) continue;
      draftOf(scenarioId).waiting.push({
        kind: 'effect',
        id: effect.key,
        playId: effect.playId,
        effectType: effect.effectType,
      });
    }
    for (const id of input.plays.refused) {
      const scenarioId = await scenarioOfPlay(id);
      if (scenarioId === undefined) continue;
      draftOf(scenarioId).waiting.push({ kind: 'play', id, playId: id, effectType: null });
    }
  } catch (error) {
    logger.error({ err: error }, 'recovery: the messages for the chats could not be put together');
  }

  const notices: ScenarioSystemMessagePayload[] = [];
  for (const scenarioId of [...drafts.keys()].sort()) {
    const draft = drafts.get(scenarioId);
    if (draft === undefined) continue;
    // A restart that only took things up again has nothing to tell in this mode.
    if (input.mode === 'unclean_only' && draft.settled.length === 0 && draft.waiting.length === 0) {
      continue;
    }
    const payload: ScenarioSystemMessagePayload = { scenarioId, kind: 'recovery', ...draft };
    try {
      await store.events.append({
        ...buildDaemonEvent('scenario.system_message', payload),
        scenarioId,
      });
      notices.push(payload);
    } catch (error) {
      logger.error({ err: error, scenarioId }, 'recovery: the message for a chat was not written');
    }
  }
  return notices;
}
