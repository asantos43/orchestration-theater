// SPDX-License-Identifier: MPL-2.0
import {
  type DecisionAnswer,
  type DecisionRecord,
  type DecisionRegistry,
  type DemandPatch,
  type DemandRecord,
  type DemandRegistry,
  type NewDecision,
  type NewDemand,
  type ScenarioPatch,
  type ScenarioRecord,
  type ScenarioRegistry,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import { buildDaemonEvent, type DaemonEventPayloads } from '@otheater/protocol';
import type { Logger } from '../logger.js';

/** What a write needs to put its event in the same transaction: the registries it reads and appends to. */
type Tx = Pick<StoreTransaction, 'decisions' | 'demands' | 'events' | 'plays' | 'scenarios'>;
type InTransaction = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

type RecordEventType =
  'decision.created' | 'decision.answered' | 'scenario.archived' | 'demand.transitioned';

/**
 * Decorates a `Store` so that the records a client keeps in its stores also write an event when
 * they move (Phase 7, P1 of docs/18, N173; architecture 5.12):
 * - `decisions.create`: `decision.created`, for every kind of decision;
 * - `decisions.decide` and `decisions.cancel`: `decision.answered` (`decided` or `cancelled`);
 * - `demands.create`: `demand.transitioned` with `from: null` and the whole record;
 * - `demands.update`: `demand.transitioned` when the state changed;
 * - `scenarios.update`: `scenario.archived` when `state` goes from `active` to `archived`.
 *
 * Many places write these records (the plays, the Director, the REST commands, the start-up); the
 * decorator is the one place that sees every write, whoever calls. The event goes in the same
 * transaction as the record, so they stand or fall together and share one instant (N177): a client
 * that applies the events holds the same `updatedAt` the REST read would give.
 *
 * A failure of the event (the registry refused it, say) never stops the write: it is logged and the
 * record goes on without it, like `chatFeedStore`. A client that missed an event heals at its next
 * snapshot. Put this decorator inside `chatFeedStore`, so `decision.created` is written before the
 * `chat.ask` of the same decision.
 *
 * Everything else passes through to the real store, bound to it.
 */
export function recordFeedStore(store: Store, logger: Pick<Logger, 'warn'>): Store {
  const announce = async <T extends RecordEventType>(
    tx: Pick<Tx, 'events'>,
    type: T,
    payload: DaemonEventPayloads[T],
    envelope: { readonly scenarioId: string; readonly playId?: string | null },
  ): Promise<void> => {
    try {
      await tx.events.append({
        ...buildDaemonEvent(type, payload),
        scenarioId: envelope.scenarioId,
        ...(envelope.playId == null ? {} : { playId: envelope.playId }),
      });
    } catch (error) {
      logger.warn({ err: error, type }, 'the record event was not written');
    }
  };

  const closed = (tx: Tx, record: DecisionRecord) => {
    if (record.state !== 'decided' && record.state !== 'cancelled') return Promise.resolve();
    return announce(
      tx,
      'decision.answered',
      {
        decisionId: record.id,
        kind: record.kind,
        state: record.state,
        decidedBy: record.decidedBy,
      },
      record,
    );
  };

  const decisionsOf = (
    decisions: DecisionRegistry,
    inTransaction: InTransaction,
  ): DecisionRegistry =>
    new Proxy(decisions, {
      get(target, property) {
        if (property === 'create') {
          return (input: NewDecision) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.create(input);
              await announce(tx, 'decision.created', { decision: record }, record);
              return record;
            });
        }
        if (property === 'decide') {
          return (id: string, answer: DecisionAnswer) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.decide(id, answer);
              await closed(tx, record);
              return record;
            });
        }
        if (property === 'cancel') {
          return (id: string) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.cancel(id);
              await closed(tx, record);
              return record;
            });
        }
        return bound(target, property);
      },
    });

  const demandEvent = async (
    tx: Tx,
    record: DemandRecord,
    from: DemandRecord['state'] | null,
  ): Promise<void> => {
    const play = await tx.plays.get(record.playId);
    if (play === undefined) return;
    await announce(
      tx,
      'demand.transitioned',
      {
        playId: record.playId,
        demandId: record.id,
        from,
        to: record.state,
        ...(from === null ? { demand: record } : {}),
      },
      { scenarioId: play.scenarioId, playId: record.playId },
    );
  };

  const demandsOf = (demands: DemandRegistry, inTransaction: InTransaction): DemandRegistry =>
    new Proxy(demands, {
      get(target, property) {
        if (property === 'create') {
          return (input: NewDemand) =>
            inTransaction(async (tx) => {
              const record = await tx.demands.create(input);
              await demandEvent(tx, record, null);
              return record;
            });
        }
        if (property === 'update') {
          return (playId: string, id: string, patch: DemandPatch) =>
            inTransaction(async (tx) => {
              const before = await tx.demands.get(playId, id);
              const record = await tx.demands.update(playId, id, patch);
              if (before !== undefined && before.state !== record.state) {
                await demandEvent(tx, record, before.state);
              }
              return record;
            });
        }
        return bound(target, property);
      },
    });

  const scenariosOf = (
    scenarios: ScenarioRegistry,
    inTransaction: InTransaction,
  ): ScenarioRegistry =>
    new Proxy(scenarios, {
      get(target, property) {
        if (property === 'update') {
          return (id: string, patch: ScenarioPatch) =>
            inTransaction(async (tx) => {
              const before: ScenarioRecord | undefined =
                patch.state === 'archived' ? await tx.scenarios.get(id) : undefined;
              const record = await tx.scenarios.update(id, patch);
              if (before?.state === 'active' && record.state === 'archived') {
                await announce(tx, 'scenario.archived', { scenarioId: id }, { scenarioId: id });
              }
              return record;
            });
        }
        return bound(target, property);
      },
    });

  const wrapRegistries = (inTransaction: InTransaction, source: Store | StoreTransaction) => ({
    decisions: decisionsOf(source.decisions, inTransaction),
    demands: demandsOf(source.demands, inTransaction),
    scenarios: scenariosOf(source.scenarios, inTransaction),
  });

  const wrapped = new WeakMap<object, object>();
  return new Proxy(store, {
    get(target, property) {
      if (property === 'decisions' || property === 'demands' || property === 'scenarios') {
        return wrapRegistries((work) => target.transaction(work), target)[property];
      }
      if (property === 'transaction') {
        return <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> =>
          target.transaction((tx) => {
            let inner = wrapped.get(tx);
            if (inner === undefined) {
              const registries = wrapRegistries((run) => run(tx), tx);
              inner = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (
                    txProperty === 'decisions' ||
                    txProperty === 'demands' ||
                    txProperty === 'scenarios'
                  ) {
                    return registries[txProperty];
                  }
                  return bound(txTarget, txProperty);
                },
              });
              wrapped.set(tx, inner);
            }
            return work(inner as StoreTransaction);
          });
      }
      return bound(target, property);
    },
  });
}

function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}
