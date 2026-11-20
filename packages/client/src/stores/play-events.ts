// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The payload of the two events the play machine writes (`play.created`, `play.transitioned`).
 * [proposta] They are defined in the daemon (`pipeline/events.ts`), which a client may not import
 * (dependency-cruiser `client-*` rules), and they are not in the protocol catalog yet; these are
 * the same shapes written again, loose in what the store does not read (extra fields are
 * accepted, so a daemon that adds one does not break the client). Moving the two to
 * `@otheater/protocol` is a step of its own; the test of these shapes against the daemon's enters
 * in P13, with the real daemon.
 */

const text = z.string().min(1);

export const PlayCreatedPayloadSchema = z.looseObject({
  flowId: text,
  flowVersion: z.int().min(1),
  need: text,
  parentPlayId: text.nullable(),
});
export type PlayCreatedPayload = z.infer<typeof PlayCreatedPayloadSchema>;

export const PlayTransitionedPayloadSchema = z.looseObject({
  event: text,
  from: text,
  to: text,
  counters: z.record(z.string(), z.int().min(0)),
  effects: z.array(text).optional(),
  reason: z.string().optional(),
});
export type PlayTransitionedPayload = z.infer<typeof PlayTransitionedPayloadSchema>;

/** Final states of the play machine (`DONE`, `CANCELLED`), the ones that set `finishedAt`. */
export const FINAL_PLAY_STATES: readonly string[] = ['DONE', 'CANCELLED'];

/** True when `state` is a state a play does not leave. */
export function isFinalPlayState(state: string): boolean {
  return FINAL_PLAY_STATES.includes(state);
}
