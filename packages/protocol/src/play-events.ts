// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The states of the play and the payloads of the two events the play machine writes
 * (`play.created`, `play.transitioned`; architecture 5.4). The daemon registers the event types
 * (`pipeline/events.ts`) with these schemas and a client (`packages/client`) reads the events with
 * the same ones, so there is one definition of each. [proposta] Moved here from the daemon in the
 * corrections of P13 (docs/17); the shapes are the ones the daemon always wrote.
 */

/**
 * The states of the play (architecture 5.4). `NEED` is the state before the first transition: the
 * play exists with its need and waits for `START`. [proposta] `CANCELLED` is the end the menu
 * option "cancel" leads to; the architecture draws it without naming it.
 */
export const PLAY_STATES = [
  'NEED',
  'PLANNING',
  'CLARIFYING',
  'REVIEWING_PLAN',
  'SCRIPTING',
  'REVIEWING_SCRIPT',
  'EXECUTING',
  'INTEGRATING',
  'CRITIQUING',
  'DECIDING',
  'DELIVERING',
  'AWAITING_PRODUCER',
  'DONE',
  'CANCELLED',
] as const;
export type PlayState = (typeof PLAY_STATES)[number];

/** The states a play does not leave; they are the ones that set `finishedAt`. */
export const FINAL_PLAY_STATES = ['DONE', 'CANCELLED'] as const satisfies readonly PlayState[];

/** True when `state` is a state a play does not leave. */
export function isFinalPlayState(state: string): boolean {
  return (FINAL_PLAY_STATES as readonly string[]).includes(state);
}

const text = z.string().min(1);

/** `play.created`: the play exists, in NEED, before its first event. [proposta] */
export const PlayCreatedPayloadSchema = z.strictObject({
  flowId: text,
  flowVersion: z.int().min(1),
  need: text,
  parentPlayId: text.nullable(),
});
export type PlayCreatedPayload = z.infer<typeof PlayCreatedPayloadSchema>;

/**
 * `play.transitioned`: one transition of the machine, written in the same transaction as the
 * snapshot (5.4, 5.21). [proposta] `effects` lists the types of the effects the transition
 * asked for, so the log tells what was about to start even if the daemon died before it did.
 * `reason` is the reason the event carried (a veto, `SUBMIT_FAILED`, a failed attempt), so the
 * log tells why the play moved: it is not in the machine context for every event. Optional, so the
 * events already written stay valid (same schema version).
 */
export const PlayTransitionedPayloadSchema = z.strictObject({
  event: text,
  from: z.enum(PLAY_STATES),
  to: z.enum(PLAY_STATES),
  counters: z.record(z.string(), z.int().min(0)),
  effects: z.array(text),
  reason: z.string().optional(),
});
export type PlayTransitionedPayload = z.infer<typeof PlayTransitionedPayloadSchema>;
