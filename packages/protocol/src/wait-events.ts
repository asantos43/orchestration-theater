// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of `wait.started` and `wait.ended` (Phase 8, P15, N222 (a); architecture 5.11). Registered
 * in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. [proposta] The names
 * and the fields.
 *
 * A wait of the daemon that the log said nothing about (a prompt in the queue for the Director, a
 * session in the queue of the pool) is told here when it lasts longer than
 * `events.wait_threshold`: `wait.started` when the threshold is reached (so the log shows the wait
 * while it goes on), `wait.ended` when it ends. A wait shorter than the threshold writes neither,
 * and `wait.ended` is only written for a wait that has its `wait.started`. The projector of the
 * spans (`otheater.wait`) reads the pair like the other waits the log tells, so a telemetry base
 * that is recreated gets these spans again; hooks and plugins read the events (the owner's rule that
 * a situation of the daemon is also an event, 2026-11-18).
 *
 * The waits the log already told (`attempt.reset_wait_*`, `demand.*`, the Director's wait) keep their
 * own events. The ids of the play, the scenario and the attempt are also in the envelope.
 */

const id = z.string().min(1).max(256);
const epochMs = z.int().min(0);
const short = z.string().min(1).max(128);

/** What waited: a prompt in the queue of the Director, or a session in the queue of the pool. */
export const WAIT_EVENT_KINDS = ['prompt_queue', 'pool_admission'] as const;
export type WaitEventKind = (typeof WAIT_EVENT_KINDS)[number];

/**
 * Why it waited. Pool: `max_sessions` (`pool.max_sessions` reached), `local_slot` (the local instance
 * has no vacancy), `quota`, `ram`, `ram_unknown` (the free RAM could not be read). Prompt: `director_busy`
 * (a turn of the Director was going on), `no_director` (nobody to receive it), `queued` (nothing in the
 * way but the store), `restart` (found in the queue after a restart). A wait may have several.
 */
export const WAIT_EVENT_REASONS = [
  'max_sessions',
  'local_slot',
  'quota',
  'ram',
  'ram_unknown',
  'director_busy',
  'no_director',
  'queued',
  'restart',
] as const;
export type WaitEventReason = (typeof WAIT_EVENT_REASONS)[number];

/** How a wait ended: handed over, admitted, given up by the caller, or dropped by a shutdown. */
export const WAIT_EVENT_OUTCOMES = ['delivered', 'admitted', 'cancelled', 'pool_closed'] as const;
export type WaitEventOutcome = (typeof WAIT_EVENT_OUTCOMES)[number];

/** What both events say about the wait: who waited, for what, since when. */
const wait = {
  /** Makes the wait this one: the id of the prompt, or the key of the request to the pool. */
  waitId: id,
  kind: z.enum(WAIT_EVENT_KINDS),
  /** Why, up to the moment of the event (`wait.ended` has them all). Sorted, with no repeats. */
  reasons: z.array(z.enum(WAIT_EVENT_REASONS)).min(1).max(WAIT_EVENT_REASONS.length),
  /** When the wait began (the clock of the daemon); it can be before the event. */
  since: epochMs,
  scenarioId: id.optional(),
  playId: id.optional(),
  attemptId: id.optional(),
  role: short.optional(),
  client: short.optional(),
  profile: short.optional(),
  /** `prompt_queue` only: who wrote the prompt (`PromptOrigin`) and with which priority. */
  promptSource: short.optional(),
  promptPriority: z.int().optional(),
};

/**
 * `wait.started`: the wait reached `events.wait_threshold` (`thresholdMs`) and goes on. A wait that
 * was already older than the threshold when the daemon first saw it (a prompt a restart found in the
 * queue) is told at once, with `since` before the event.
 */
export const WaitStartedPayloadSchema = z.strictObject({
  ...wait,
  thresholdMs: z.int().min(0),
});
export type WaitStartedPayload = z.infer<typeof WaitStartedPayloadSchema>;

/** `wait.ended`: the wait of `wait.started` ended; `waitedMs` is the whole of it, from `since`. */
export const WaitEndedPayloadSchema = z.strictObject({
  ...wait,
  outcome: z.enum(WAIT_EVENT_OUTCOMES),
  waitedMs: z.int().min(0),
});
export type WaitEndedPayload = z.infer<typeof WaitEndedPayloadSchema>;
