// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import type { StoreAggregates } from '../ports/store.js';
import { BLACKBOARD_SPEC, TableBlackboard } from './blackboard.js';
import { DIRECTIVES_SPEC, TableDirectiveRegistry } from './directives.js';
import {
  DECISIONS_SPEC,
  DEMANDS_SPEC,
  PLAYS_SPEC,
  STAGES_SPEC,
  TableDecisionRegistry,
  TableDemandRegistry,
  TablePlayRegistry,
  TableStageRegistry,
} from './plays.js';
import { PROMPT_QUEUE_SPEC, TablePromptQueue } from './prompt-queue.js';
import type { TableFactory } from './record-table.js';
import {
  ATTACHMENTS_SPEC,
  SCENARIOS_SPEC,
  SCENARIO_REPOS_SPEC,
  TableAttachmentRegistry,
  TableScenarioRegistry,
  TableScenarioRepoRegistry,
} from './scenarios.js';
import { SESSIONS_SPEC, TableSessionRegistry } from './sessions.js';
import { SIDE_EFFECTS_SPEC, TableSideEffectRegistry } from './side-effects.js';

export * from './blackboard.js';
export * from './directives.js';
export * from './plays.js';
export * from './prompt-queue.js';
export * from './record-table.js';
export * from './scenarios.js';
export * from './sessions.js';
export * from './side-effects.js';
export * from './support.js';

/** Names of the tables the Phase 3 aggregates use, in the order the migrations create them. */
export const AGGREGATE_TABLE_NAMES: readonly string[] = [
  SCENARIOS_SPEC.name,
  SCENARIO_REPOS_SPEC.name,
  ATTACHMENTS_SPEC.name,
  PLAYS_SPEC.name,
  STAGES_SPEC.name,
  DEMANDS_SPEC.name,
  DECISIONS_SPEC.name,
  BLACKBOARD_SPEC.name,
  PROMPT_QUEUE_SPEC.name,
  SIDE_EFFECTS_SPEC.name,
  SESSIONS_SPEC.name,
  DIRECTIVES_SPEC.name,
];

/**
 * The aggregates of the Phase 3 store, written once over the tables a backend gives (`tables`).
 * [proposta] The in-memory store and the SQLite adapter only implement {@link TableFactory}; the
 * rules (validation, defaults, numbering, state changes) are the same code in both.
 */
export function createStoreAggregates(
  tables: TableFactory,
  clock: Pick<Clock, 'now'>,
): StoreAggregates {
  return {
    scenarios: new TableScenarioRegistry(tables(SCENARIOS_SPEC), clock),
    scenarioRepos: new TableScenarioRepoRegistry(tables(SCENARIO_REPOS_SPEC), clock),
    attachments: new TableAttachmentRegistry(tables(ATTACHMENTS_SPEC), clock),
    plays: new TablePlayRegistry(tables(PLAYS_SPEC), clock),
    stages: new TableStageRegistry(tables(STAGES_SPEC), clock),
    demands: new TableDemandRegistry(tables(DEMANDS_SPEC), clock),
    decisions: new TableDecisionRegistry(tables(DECISIONS_SPEC), clock),
    blackboard: new TableBlackboard(tables(BLACKBOARD_SPEC), clock),
    promptQueue: new TablePromptQueue(tables(PROMPT_QUEUE_SPEC), clock),
    sideEffects: new TableSideEffectRegistry(tables(SIDE_EFFECTS_SPEC), clock),
    sessions: new TableSessionRegistry(tables(SESSIONS_SPEC), clock),
    directives: new TableDirectiveRegistry(tables(DIRECTIVES_SPEC), clock),
  };
}

type AggregateName = keyof StoreAggregates;

/**
 * Which methods of each aggregate only read. Outside a transaction a read sees committed data
 * and never waits for a transaction; any other method runs in a transaction of its own.
 */
export const AGGREGATE_READ_METHODS: Readonly<Record<AggregateName, readonly string[]>> = {
  scenarios: ['get', 'list'],
  scenarioRepos: ['get', 'list'],
  attachments: ['get', 'list'],
  plays: ['get', 'list'],
  stages: ['get', 'list'],
  demands: ['get', 'list'],
  decisions: ['get', 'list'],
  blackboard: ['get', 'history', 'latest'],
  promptQueue: ['get', 'list', 'next'],
  sideEffects: ['get', 'list'],
  sessions: ['get', 'list'],
  directives: ['get', 'list', 'inForce'],
};

/** The methods of each aggregate that write: each one is a single-call transaction outside one. */
export const AGGREGATE_WRITE_METHODS: Readonly<Record<AggregateName, readonly string[]>> = {
  scenarios: ['create', 'update'],
  scenarioRepos: ['put', 'remove'],
  attachments: ['add'],
  plays: ['create', 'update'],
  stages: ['create', 'update'],
  demands: ['create', 'update'],
  decisions: ['create', 'decide', 'cancel'],
  blackboard: ['put'],
  promptQueue: ['enqueue', 'markDelivered'],
  sideEffects: ['intend', 'resolve'],
  sessions: ['open', 'update'],
  directives: ['create', 'extend', 'revoke', 'refreshStates'],
};

type AnyMethod = (...args: unknown[]) => Promise<unknown>;

function call(target: object, method: string, args: readonly unknown[]): Promise<unknown> {
  const fn = (target as Record<string, AnyMethod | undefined>)[method];
  if (typeof fn !== 'function') return Promise.reject(new TypeError(`No method ${method}`));
  return fn.apply(target, [...args]);
}

/**
 * The aggregates of `store.*` (outside a transaction), built from the two things a store has:
 * the aggregates over its committed view (`readView`, for reads) and a way to run a transaction
 * (`inTransaction`, for writes). `beforeRead` throws when the store is closed.
 */
export function autoCommitAggregates(
  readView: StoreAggregates,
  inTransaction: <T>(fn: (tx: StoreAggregates) => Promise<T>) => Promise<T>,
  beforeRead: () => void,
): StoreAggregates {
  const out: Partial<Record<AggregateName, unknown>> = {};
  for (const name of Object.keys(AGGREGATE_READ_METHODS) as AggregateName[]) {
    const reads = new Set(AGGREGATE_READ_METHODS[name]);
    const writes = new Set(AGGREGATE_WRITE_METHODS[name]);
    out[name] = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== 'string') return undefined;
          if (reads.has(property)) {
            return (...args: unknown[]): Promise<unknown> => {
              try {
                beforeRead();
              } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error(String(error)));
              }
              return call(readView[name], property, args);
            };
          }
          if (writes.has(property)) {
            return (...args: unknown[]): Promise<unknown> =>
              inTransaction((tx) => call(tx[name], property, args));
          }
          return undefined;
        },
      },
    );
  }
  return out as StoreAggregates;
}
