// SPDX-License-Identifier: MPL-2.0
import {
  DecisionAnsweredPayloadSchema,
  DecisionCreatedPayloadSchema,
  type ApiDecision,
} from '@otheater/protocol';
import {
  byNumberThenId,
  clearStale,
  emptySync,
  payloadOf,
  without,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The judgment points still pending (state `pending`) of each scenario. [proposta] Built from the
 * events alone, with no read per transition (N173, P1 of docs/18): `decision.created` carries the
 * whole record and adds it to the list of its scenario, `decision.answered` (a decision `decided`
 * or `cancelled`) takes it out, `scenario.created` opens an empty list and `scenario.archived`
 * drops the list, as a new snapshot would (it reads the active scenarios only). A decision of any
 * kind goes in, the way `GET /v1/scenarios/:id/decisions?state=pending` lists them. Nothing marks a
 * key stale any more: the REST read of a list (`settleDecisions`) stays for a snapshot and for a
 * client that asks for one.
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
    case 'scenario.created': {
      const id = event.scenarioId ?? scenarioIdOf(event.payload);
      if (id === undefined || id in state.byScenario) return state;
      return { ...state, byScenario: { ...state.byScenario, [id]: [] } };
    }
    case 'scenario.archived': {
      const id = event.scenarioId ?? scenarioIdOf(event.payload);
      if (id === undefined || !(id in state.byScenario)) return state;
      return { ...state, byScenario: without(state.byScenario, id) };
    }
    case 'decision.created': {
      const payload = payloadOf(DecisionCreatedPayloadSchema, event);
      if (payload === undefined || payload.decision.state !== 'pending') return state;
      const id = payload.decision.scenarioId;
      const list = state.byScenario[id] ?? [];
      if (list.some((decision) => decision.id === payload.decision.id)) return state;
      return {
        ...state,
        byScenario: { ...state.byScenario, [id]: sorted([...list, payload.decision]) },
      };
    }
    case 'decision.answered': {
      const payload = payloadOf(DecisionAnsweredPayloadSchema, event);
      const id = event.scenarioId;
      if (payload === undefined || id === undefined) return state;
      const list = state.byScenario[id];
      if (list === undefined || !list.some((decision) => decision.id === payload.decisionId)) {
        return state;
      }
      return {
        ...state,
        byScenario: {
          ...state.byScenario,
          [id]: list.filter((decision) => decision.id !== payload.decisionId),
        },
      };
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
