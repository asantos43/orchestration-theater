// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the Director's supervision (N309, D8; plan of Phase 11b, P14).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. The
 * scenario, the play and the attempt are in the envelope. [proposta] The names of the fields. The
 * text of a warning is clipped to {@link SUPERVISION_TEXT_MAX} characters: the whole text lives
 * in the blackboard of the play (`supervision/<demand>`), so a hook sees that a warning went and
 * reads the rest from there when it may.
 */

/** The longest text an event of the supervision carries. */
export const SUPERVISION_TEXT_MAX = 500;

/** The deterministic signals the daemon looks for (N309). */
export const SUPERVISION_SIGNALS = [
  'outside_demand',
  'contract_changed',
  'test_loop',
  'budget_fraction',
] as const;
export type SupervisionSignal = (typeof SUPERVISION_SIGNALS)[number];

/**
 * What the daemon did with a signal: called the Director, sent the dependents a notice itself
 * (`contract_changed`), only recorded it (`supervision.mode: log`), or held it back by a limit.
 */
export const SUPERVISION_SIGNAL_OUTCOMES = [
  'director_called',
  'notified',
  'logged',
  'limited',
] as const;
export type SupervisionSignalOutcome = (typeof SUPERVISION_SIGNAL_OUTCOMES)[number];

/** The kinds of message the channel carries to an Actor. */
export const SUPERVISION_NOTICE_KINDS = [
  'warn',
  'redirect',
  'broadcast',
  'contract',
  'status_request',
  'question',
] as const;
export type SupervisionNoticeKind = (typeof SUPERVISION_NOTICE_KINDS)[number];

/** The limits of the supervision. */
export const SUPERVISION_LIMITS = [
  'max_warnings_per_demand',
  'director_budget',
  'broadcast',
  'status_request',
] as const;
export type SupervisionLimit = (typeof SUPERVISION_LIMITS)[number];

const text = z.string().max(SUPERVISION_TEXT_MAX);

/** `supervision.signal`: a signal fired for an attempt (or, for `contract_changed`, a play). */
export const SupervisionSignalPayloadSchema = z.strictObject({
  signal: z.enum(SUPERVISION_SIGNALS),
  demandId: z.string().min(1).nullable(),
  /** What was seen (a path, the contract, the test, the fraction), clipped. */
  detail: text,
  outcome: z.enum(SUPERVISION_SIGNAL_OUTCOMES),
  /** The attempts the signal is about (the ones that depend on a changed contract). */
  attemptIds: z.array(z.string().min(1)).max(100),
});

/**
 * `supervision.warning`: a message of the Director to an Actor was queued (`delivered: false`,
 * `reason: 'queued'`), put in a tool reply (`delivered: true`), or lost because the attempt ended
 * without calling a tool again (`delivered: false`, `reason: 'attempt_ended'`).
 */
export const SupervisionWarningPayloadSchema = z.strictObject({
  kind: z.enum(SUPERVISION_NOTICE_KINDS),
  noticeId: z.string().min(1),
  demandId: z.string().min(1).nullable(),
  delivered: z.boolean(),
  reason: z.enum(['queued', 'delivered', 'attempt_ended']),
  text,
});

/** `supervision.redirect`: the Director cancelled an attempt so it relaunches with the warning. */
export const SupervisionRedirectPayloadSchema = z.strictObject({
  demandId: z.string().min(1).nullable(),
  text,
});

/** `supervision.broadcast`: the Director sent one warning to every Actor running in the play. */
export const SupervisionBroadcastPayloadSchema = z.strictObject({
  recipients: z.int().min(0),
  attemptIds: z.array(z.string().min(1)).max(100),
  text,
});

/** `supervision.status_requested`: the Director asked an Actor for a partial state. */
export const SupervisionStatusRequestedPayloadSchema = z.strictObject({
  demandId: z.string().min(1).nullable(),
  noticeId: z.string().min(1),
});

/** `supervision.limit_reached`: a call or a signal was held back by a limit. */
export const SupervisionLimitReachedPayloadSchema = z.strictObject({
  limit: z.enum(SUPERVISION_LIMITS),
  demandId: z.string().min(1).nullable(),
  /** The value the call would have reached. */
  value: z.int().min(0),
  max: z.int().min(0),
});
