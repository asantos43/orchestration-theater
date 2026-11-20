// SPDX-License-Identifier: MPL-2.0
import {
  type DecisionAnswer,
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
 * (P7 of docs/17), and settling one (`decide` or `cancel`) writes a `chat.ask_closed` event (N179,
 * item 2). The chat WebSocket gives each message the id of the event that produced it; a pending
 * question had no event, so this writes it, in the same transaction as the decision when it can
 * (the decision and its event stand or fall together). Ten places create decisions and several
 * settle them (the socket, the REST route, the plays, the start-up); the decorator is the one place
 * that knows which of them are for the Producer, whoever calls.
 *
 * A failure of the event (the registry refused it, say) never stops the decision: it is logged and
 * the decision goes on without it. A decision with no `chat.ask` still reaches a client that
 * resumes, through the state (N179, item 3).
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
  const close = async (record: DecisionRecord, events: Pick<EventLog, 'append'>) => {
    if (!isChatAskKind(record.kind)) return;
    if (record.state !== 'decided' && record.state !== 'cancelled') return;
    try {
      await events.append({
        ...buildDaemonEvent('chat.ask_closed', {
          decisionId: record.id,
          kind: record.kind,
          state: record.state,
        }),
        scenarioId: record.scenarioId,
        ...(record.playId === null ? {} : { playId: record.playId }),
      });
    } catch (error) {
      logger.warn(
        { err: error, decisionId: record.id },
        'the chat.ask_closed event was not written',
      );
    }
  };
  const wrapped = new WeakMap<object, object>();
  /** The registry of `events` (a transaction, or the store with a transaction of its own per call). */
  const decisionsOf = (
    decisions: DecisionRegistry,
    inTransaction: <T>(
      work: (tx: Pick<StoreTransaction, 'decisions' | 'events'>) => Promise<T>,
    ) => Promise<T>,
  ): DecisionRegistry =>
    new Proxy(decisions, {
      get(target, property) {
        if (property === 'create') {
          return (input: NewDecision) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.create(input);
              await announce(record, tx.events);
              return record;
            });
        }
        if (property === 'decide') {
          return (id: string, answer: DecisionAnswer) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.decide(id, answer);
              await close(record, tx.events);
              return record;
            });
        }
        if (property === 'cancel') {
          return (id: string) =>
            inTransaction(async (tx) => {
              const record = await tx.decisions.cancel(id);
              await close(record, tx.events);
              return record;
            });
        }
        return bound(target, property);
      },
    });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'decisions') {
        return decisionsOf(target.decisions, (work) => target.transaction(work));
      }
      if (property === 'transaction') {
        return <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> =>
          target.transaction((tx) => {
            let inner = wrapped.get(tx);
            if (inner === undefined) {
              inner = new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === 'decisions') {
                    return decisionsOf(txTarget.decisions, (work) => work(txTarget));
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
