// SPDX-License-Identifier: MPL-2.0
import {
  type DecisionRecord,
  type DecisionRegistry,
  type EventLog,
  type NewDecision,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import { IDEA_GROUP_DECISION } from '../ideas/index.js';
import type { Logger } from '../logger.js';
import { DECISION_KINDS } from './play-effects.js';

/**
 * The decisions the Producer is the one to answer, as the chat shows them (the same set the poll
 * of the channel lists): a question of the Director, the menu of a play, an effect the start-up
 * could not settle and a group of ideas that waits for approval. The judgment points (`judge.*`,
 * `clarify`) are the Director's and never reach the chat.
 */
export function isChatAskKind(kind: string): boolean {
  return (
    kind === DECISION_KINDS.question ||
    kind === DECISION_KINDS.menu ||
    kind === DECISION_KINDS.recovery ||
    kind === IDEA_GROUP_DECISION
  );
}

/**
 * Decorates a `Store` so that creating a decision for the Producer also writes a `chat.ask` event
 * (P7 of docs/17). The chat WebSocket gives each message the id of the event that produced it; a
 * pending question had no event, so this writes it, in the same transaction as the decision when it
 * can (the decision and its event stand or fall together). Ten places create decisions; the
 * decorator is the one place that knows which of them are for the Producer.
 *
 * A failure of the event (the registry refused it, say) never stops the decision: it is logged and
 * the decision is created without it, so the old poll of the channel still shows it.
 *
 * Everything but `decisions.create` passes through to the real store, bound to it, like
 * `validateEventsOf`.
 */
export function chatFeedStore(store: Store, logger: Pick<Logger, 'warn'>): Store {
  const announce = async (record: DecisionRecord, events: Pick<EventLog, 'append'>) => {
    if (!isChatAskKind(record.kind)) return;
    try {
      await events.append({
        ...buildDaemonEvent('chat.ask', {
          decisionId: record.id,
          kind: record.kind,
          input: record.input,
        }),
        scenarioId: record.scenarioId,
        ...(record.playId === null ? {} : { playId: record.playId }),
      });
    } catch (error) {
      logger.warn({ err: error, decisionId: record.id }, 'the chat.ask event was not written');
    }
  };
  const wrapped = new WeakMap<object, object>();
  const decisionsOf = (
    decisions: DecisionRegistry,
    create: (input: NewDecision) => Promise<DecisionRecord>,
  ): DecisionRegistry =>
    new Proxy(decisions, {
      get(target, property) {
        if (property === 'create') return create;
        return bound(target, property);
      },
    });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'decisions') {
        return decisionsOf(target.decisions, (input) =>
          target.transaction(async (tx) => {
            const record = await tx.decisions.create(input);
            await announce(record, tx.events);
            return record;
          }),
        );
      }
      if (property === 'transaction') {
        return <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> =>
          target.transaction((tx) => {
            let inner = wrapped.get(tx);
            if (inner === undefined) {
              inner = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === 'decisions') {
                    return decisionsOf(txTarget.decisions, async (input) => {
                      const record = await txTarget.decisions.create(input);
                      await announce(record, txTarget.events);
                      return record;
                    });
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
