// SPDX-License-Identifier: MPL-2.0
import {
  ScenarioCreatedPayloadSchema,
  ScenarioDirectorSleptPayloadSchema,
  ScenarioDirectorWokePayloadSchema,
  type ApiScenario,
} from '@otheater/protocol';
import {
  byNumberThenId,
  clearStale,
  emptySync,
  markStale,
  payloadOf,
  without,
  type EventReducer,
  type SyncFields,
} from './core.js';

/**
 * The scenarios (projects, tasks and chats) of one daemon, by id. The REST list gives the
 * snapshot; the events keep the Director's state, and tell when a scenario is born. [proposta]
 * `scenario.created` does not carry the record (no `profile`, `baseBranch`, `state`), so it marks
 * the scenario to be read by `GET /v1/scenarios/:id`. There is no event for archiving a scenario
 * yet (a finding of P11 for the daemon): its `state` is as fresh as the last read.
 */

export interface ScenariosState extends SyncFields {
  readonly byId: Readonly<Record<string, ApiScenario>>;
}

export function initialScenarios(): ScenariosState {
  return { ...emptySync(), byId: {} };
}

export const reduceScenarios: EventReducer<ScenariosState> = (state, event) => {
  switch (event.type) {
    case 'scenario.created': {
      const payload = payloadOf(ScenarioCreatedPayloadSchema, event);
      const id = payload?.scenarioId ?? event.scenarioId;
      if (id === undefined || id in state.byId) return state;
      return markStale(state, id);
    }
    case 'scenario.director_slept':
    case 'scenario.director_woke': {
      const payload =
        event.type === 'scenario.director_slept'
          ? payloadOf(ScenarioDirectorSleptPayloadSchema, event)
          : payloadOf(ScenarioDirectorWokePayloadSchema, event);
      const id = payload?.scenarioId ?? event.scenarioId;
      if (id === undefined) return state;
      const known = state.byId[id];
      // An event of a scenario this store does not have: read it.
      if (known === undefined) return markStale(state, id);
      const directorState = event.type === 'scenario.director_slept' ? 'asleep' : 'active';
      if (payload === undefined) return markStale(state, id);
      if (known.directorState === directorState) return state;
      return {
        ...state,
        byId: {
          ...state.byId,
          // [proposta] The store stamps `updatedAt` with the clock that stamps the event: both
          // are written in the same transaction (to be checked against the daemon in P13).
          [id]: { ...known, directorState, updatedAt: Math.max(known.updatedAt, event.timestamp) },
        },
      };
    }
    default:
      return state;
  }
};

/** A snapshot: every scenario read, replacing what was there. */
export function installScenarios(
  scenarios: readonly ApiScenario[],
  lastEventId: number,
): ScenariosState {
  return {
    loaded: true,
    lastEventId,
    stale: {},
    byId: Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario])),
  };
}

/** The answer of a read of one scenario: the record, or `null` when it is gone (404). */
export function settleScenario(
  state: ScenariosState,
  id: string,
  revision: number,
  scenario: ApiScenario | null,
): ScenariosState {
  const next: ScenariosState =
    scenario === null
      ? { ...state, byId: without(state.byId, id) }
      : { ...state, byId: { ...state.byId, [id]: scenario } };
  return clearStale(next, id, revision);
}

/** The scenarios, oldest first. */
export function selectScenarios(state: ScenariosState): ApiScenario[] {
  return Object.values(state.byId).sort(byNumberThenId((scenario) => scenario.createdAt));
}
