// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  parseNewEvent,
  type EventLog,
  type EventRegistry,
  type NewEvent,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import type { EventUnknownTypeMode } from './config.js';
import type { Logger } from './logger.js';

/** What the event validation needs: the registry, what to do on a problem, and where to warn. */
export interface EventValidation {
  readonly registry: EventRegistry;
  readonly unknownType: EventUnknownTypeMode;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Decorates an `EventLog` so every `append` goes through the event registry (owner's decision N80,
 * 2026-11-17). The `EventLog` port does not change: the check runs before the call reaches it.
 *
 * - `reject`: an unknown type, an unsupported `schemaVersion` or a payload that fails its schema
 *   throws `InvalidInput` and nothing is stored.
 * - `warn`: the event is stored anyway and the daemon logs a warning naming the type.
 *
 * An event that is not even a valid envelope is left to the port, which rejects it in both modes.
 */
export function validateEvents(log: EventLog, validation: EventValidation): EventLog {
  const { registry, unknownType, logger } = validation;
  return {
    append: (event: NewEvent) => {
      // Only the envelope is parsed here; a bad envelope falls through to the port's own error.
      const parsed = tryParse(event);
      if (parsed !== undefined) {
        const check = registry.checkEvent(parsed.type, parsed.schemaVersion, parsed.payload);
        if (!check.ok) {
          if (unknownType === 'reject') {
            return Promise.reject(
              new InvalidInput(
                check.message,
                check.cause === undefined ? undefined : { cause: check.cause },
              ),
            );
          }
          logger.warn(
            { type: parsed.type, schemaVersion: parsed.schemaVersion, reason: check.reason },
            `event stored although it is not valid for the registry: ${check.message}`,
          );
        }
      }
      return log.append(event);
    },
    readFrom: (afterId, limit) => log.readFrom(afterId, limit),
    lastId: () => log.lastId(),
  };
}

function tryParse(event: NewEvent): NewEvent | undefined {
  try {
    return parseNewEvent(event);
  } catch {
    return undefined;
  }
}

/**
 * Decorates a `Store` so its `events` log, and the one inside every transaction, validate each
 * `append`. Everything else (attempts, the maintenance capability, the aggregates other steps add)
 * passes through to the real store untouched, bound to it.
 */
export function validateEventsOf(store: Store, validation: EventValidation): Store {
  const wrapped = new WeakMap<object, object>();
  const wrap = <T extends object>(target: T, build: (target: T) => object): object => {
    let cached = wrapped.get(target);
    if (cached === undefined) {
      cached = build(target);
      wrapped.set(target, cached);
    }
    return cached;
  };
  const events = validateEvents(store.events, validation);
  return new Proxy(store, {
    get(target, property) {
      if (property === 'events') return events;
      if (property === 'transaction') {
        return <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(txTarget, txProperty) {
                  if (txProperty === 'events') {
                    return wrap(txTarget.events, (log) => validateEvents(log, validation));
                  }
                  return bound(txTarget, txProperty);
                },
              }),
            ),
          );
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
