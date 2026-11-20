// SPDX-License-Identifier: MPL-2.0
import type { ApiDecision } from '@otheater/protocol';
import {
  byNumberThenId,
  clearStale,
  emptySync,
  markStale,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The judgment points still pending (state `pending`) of each scenario. [proposta] The daemon
 * writes a decision, and the answer to it, with no event of its own, so there is nothing to apply
 * to a list: what the log does say is that something moved in the scenario (`play.transitioned`,
 * `scenario.chat_transitioned`, `scenario.created`), and the list of that scenario is marked to
 * be read again by `GET /v1/scenarios/:id/decisions?state=pending`. A finding of P11: events
 * `decision.created` and `decision.answered` in the catalog would let this store keep the list
 * by itself and save those reads.
 */

export interface DecisionsState extends SyncFields {
  /** The pending decisions of each scenario, oldest first. */
  readonly byScenario: Readonly<Record<string, readonly ApiDecision[]>>;
}

export function initialDecisions(): DecisionsState {
  return { ...emptySync(), byScenario: {} };
}

export const reduceDecisions: EventReducer<DecisionsState> = (state, event) => {
  switch (event.type) {
    case 'play.transitioned':
    case 'scenario.chat_transitioned':
    case 'scenario.created': {
      const id = event.scenarioId ?? scenarioIdOf(event.payload);
      if (id === undefined) return state;
      return markStale(state, id);
    }
    default:
      return state;
  }
};

function scenarioIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.scenarioId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function sorted(decisions: readonly ApiDecision[]): readonly ApiDecision[] {
  return [...decisions].sort(byNumberThenId((decision) => decision.createdAt));
}

/** A snapshot: the pending decisions of each scenario read, replacing what was there. */
export function installDecisions(
  perScenario: readonly {
    readonly scenarioId: string;
    readonly decisions: readonly ApiDecision[];
  }[],
  lastEventId: number,
): DecisionsState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byScenario: Object.fromEntries(
      perScenario.map((entry) => [entry.scenarioId, sorted(entry.decisions)]),
    ),
  };
}

/** The answer of a read of one scenario's pending decisions. */
export function settleDecisions(
  state: DecisionsState,
  scenarioId: string,
  revision: number,
  decisions: readonly ApiDecision[],
): DecisionsState {
  return clearStale(
    { ...state, byScenario: { ...state.byScenario, [scenarioId]: sorted(decisions) } },
    scenarioId,
    revision,
  );
}

/** Every pending decision of every scenario, oldest first. */
export function selectPendingDecisions(state: DecisionsState): ApiDecision[] {
  return Object.values(state.byScenario)
    .flat()
    .sort(byNumberThenId((decision) => decision.createdAt));
}
