// SPDX-License-Identifier: MPL-2.0
import type { EventLog, NewEvent } from '@otheater/core';
import {
  buildDaemonEvent,
  type DaemonEventPayloads,
  type DaemonEventType,
} from '@otheater/protocol';
import { eventErrorText } from './execution/continuation-package.js';

/** What the situations need from a logger: where a write that failed is told (a pino logger fits). */
export interface SituationErrorLog {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * The situations of the daemon that are also events (Phase 5, P24, N146 and N149; the owner's order
 * of 2026-11-18): everything the daemon only wrote to the log as a warning or a notice, for a
 * business reason, is also an event, so hooks and plugins can read it. The log line stays, and the
 * event is written at the same point.
 *
 * [proposta] The rules of this module:
 * - recording never throws and never waits: the places that call it are synchronous callbacks
 *   (`onWarning`, a listener) or paths that must not change because an event could not be written;
 * - the events are written one after the other, in the order they were recorded;
 * - an event recorded before the daemon is open (compose, the vault) waits in a queue, and
 *   {@link SituationLog.open} writes it after `daemon.started`, so the log reads in the order the
 *   things happened;
 * - a failure to write is only logged (`logger.error`): a situation of the log that cannot reach the
 *   event log is the one case that stays log-only.
 */

/** The correlation ids of the envelope (`events` columns), when the situation has them. */
export interface SituationCorrelation {
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  readonly attemptId?: string | undefined;
}

/** What a module needs to record a situation. Optional in every option bag: tests may leave it out. */
export interface SituationSink {
  record<T extends DaemonEventType>(
    type: T,
    payload: DaemonEventPayloads[T],
    correlation?: SituationCorrelation,
  ): void;
}

/**
 * Writes one situation now and resolves when it is done. It never rejects: a failure (a payload
 * that does not fit its schema, a store that is closed) is only logged. For the callers that can
 * wait for the write (an `ot` command with no daemon, where the process may end right after).
 */
export async function writeSituation<T extends DaemonEventType>(
  events: Pick<EventLog, 'append'>,
  logger: SituationErrorLog,
  type: T,
  payload: DaemonEventPayloads[T],
  correlation: SituationCorrelation = {},
): Promise<void> {
  try {
    await events.append({
      ...buildDaemonEvent(type, payload),
      ...(correlation.scenarioId === undefined ? {} : { scenarioId: correlation.scenarioId }),
      ...(correlation.playId === undefined ? {} : { playId: correlation.playId }),
      ...(correlation.attemptId === undefined ? {} : { attemptId: correlation.attemptId }),
    });
  } catch (error) {
    logger.error({ err: situationText(error, 200), type }, 'a situation event was not written');
  }
}

export interface SituationLogOptions {
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: SituationErrorLog;
  /** Starts open (a daemon that is already running); default `false`: the queue waits for `open`. */
  readonly open?: boolean;
}

/** The {@link SituationSink} of the daemon: a queue, a chain of writes and a log of the failures. */
export class SituationLog implements SituationSink {
  readonly #o: SituationLogOptions;
  #open: boolean;
  #queue: (() => Promise<void>)[] = [];
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SituationLogOptions) {
    this.#o = options;
    this.#open = options.open ?? false;
  }

  record<T extends DaemonEventType>(
    type: T,
    payload: DaemonEventPayloads[T],
    correlation: SituationCorrelation = {},
  ): void {
    const write = (): Promise<void> =>
      writeSituation(this.#o.events, this.#o.logger, type, payload, correlation);
    if (this.#open) this.#enqueue(write);
    else this.#queue.push(write);
  }

  /**
   * Records an event the registry of the daemon does not know by name (the `plugin.<id>.<name>` of
   * a plugin, Phase 9, P8), with the same queue, order and failure handling as {@link record}. The
   * event is the caller's to build; the validation of the log still checks it on `append`.
   */
  recordEvent(event: NewEvent, correlation: SituationCorrelation = {}): void {
    const write = async (): Promise<void> => {
      try {
        await this.#o.events.append({
          ...event,
          ...(correlation.scenarioId === undefined ? {} : { scenarioId: correlation.scenarioId }),
          ...(correlation.playId === undefined ? {} : { playId: correlation.playId }),
          ...(correlation.attemptId === undefined ? {} : { attemptId: correlation.attemptId }),
        });
      } catch (error) {
        this.#o.logger.error(
          { err: situationText(error, 200), type: event.type },
          'a situation event was not written',
        );
      }
    };
    if (this.#open) this.#enqueue(write);
    else this.#queue.push(write);
  }

  /** The daemon wrote `daemon.started`: writes what waited, in order, and writes the rest at once. */
  open(): void {
    if (this.#open) return;
    this.#open = true;
    const waiting = this.#queue;
    this.#queue = [];
    for (const write of waiting) this.#enqueue(write);
  }

  /** Resolves when every event recorded so far was written (or failed). For shutdown and tests. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#chain;
      await seen;
    } while (seen !== this.#chain);
  }

  #enqueue(write: () => Promise<void>): void {
    this.#chain = this.#chain.then(write);
  }
}

/** The longest text a `detail` or a `subject` of the notice events takes (`notice-events.ts`). */
const NOTICE_TEXT_MAX = 512;
const SUBJECT_MAX = 256;

/**
 * A text for the `detail` of a notice: the message of an error, or a string, with the known secret
 * formats masked, on one line and cut (`eventErrorText`, P18b). `null` when nothing is left, which
 * the schemas take (a `detail` is never empty).
 */
export function situationText(value: unknown, max = NOTICE_TEXT_MAX): string | null {
  const text = eventErrorText(value, { secretPaths: [] });
  if (text === '') return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** `{ detail }` for an optional `detail` field of a payload, or nothing when the text is empty. */
export function detailOf(value: unknown): { detail?: string } {
  const text = situationText(value);
  return text === null ? {} : { detail: text };
}

/** A short subject (an id, a folder name, a client) for the notices: one line, cut, `null` when empty. */
export function situationSubject(value: string): string | null {
  return situationText(value, SUBJECT_MAX);
}
