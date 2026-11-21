// SPDX-License-Identifier: MPL-2.0
import { DECIDERS, DEMAND_STATES, DecisionRecordSchema, DemandRecordSchema } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the events that say a record of the store moved (Phase 7, P1 of docs/18, N173;
 * architecture 5.12). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1.
 * [proposta] Every payload is a strict object. The scenario (and the play, when there is one) is in
 * the envelope (`scenarioId`, `playId`), so the SSE filter by scenario sees all four. The daemon
 * writes each event in the same transaction as the record, with the same instant (N177): a client
 * that applies the events keeps the stores of decisions, demands and scenarios with no REST read
 * per transition.
 */

/** The states a decision leaves `pending` for (`DECISION_STATES` without `pending`). */
export const DECISION_CLOSED_STATES = ['decided', 'cancelled'] as const;

/**
 * `decision.created`: a judgment point was born `pending`. `decision` is the whole record (what
 * `GET /v1/scenarios/:id/decisions` lists for it), so a client adds it to its list without a read.
 * Written for every kind of decision (the Producer's, the Director's own, a judge's); `kind` is
 * in the record so a client can keep only the ones it shows.
 */
export const DecisionCreatedPayloadSchema = z.strictObject({
  decision: DecisionRecordSchema,
});

/**
 * `decision.answered`: a pending decision left `pending`. `state` is `decided` when an answer was
 * recorded (by the Producer, the Director or the daemon) and `cancelled` when the decision was
 * closed with no answer. The answer itself is not in the payload (it is in the record, and may be
 * long): the event says that the decision is no longer pending, and when. `scenario.decision_answered`
 * still goes out for an answer given through the REST command; this one goes out for every close.
 */
export const DecisionAnsweredPayloadSchema = z.strictObject({
  decisionId: z.string().min(1),
  kind: z.string().min(1),
  state: z.enum(DECISION_CLOSED_STATES),
  decidedBy: z.enum(DECIDERS).nullable(),
});

/**
 * `scenario.archived`: the scenario moved from `active` to `archived`. Its Director stays as it
 * was; a client marks the record `archived` and takes the stamp of the event as `updatedAt`.
 */
export const ScenarioArchivedPayloadSchema = z.strictObject({
  scenarioId: z.string().min(1),
});

/**
 * `demand.transitioned`: a demand of a play changed state. `from` is `null` for the birth of the
 * demand (the first write), and then `demand` carries the whole record, which a client could not
 * build from the ids; later transitions carry no record (only the state and `updatedAt` move,
 * and `updatedAt` is the stamp of the event).
 */
export const DemandTransitionedPayloadSchema = z.strictObject({
  playId: z.string().min(1),
  demandId: z.string().min(1),
  from: z.enum(DEMAND_STATES).nullable(),
  to: z.enum(DEMAND_STATES),
  demand: DemandRecordSchema.optional(),
});
