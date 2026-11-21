// SPDX-License-Identifier: MPL-2.0
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_ORIGINS,
  DIRECTIVE_SCOPES,
  DIRECTIVE_STATES,
  DirectiveRecordSchema,
} from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the `directive.*` events (architecture 5.17, "Eventos"). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a strict object;
 * the scenario of a local directive also travels in the envelope (`scenarioId`).
 * [proposta] The fields below, in camelCase like the other payloads of the daemon.
 */

const directiveId = z.string().regex(/^O[1-9][0-9]*$/);
const epochMs = z.int().min(0);

/** `directive.created`: a draft the Producer confirmed became an order. */
export const DirectiveCreatedPayloadSchema = z.strictObject({
  directiveId,
  scope: z.enum(DIRECTIVE_SCOPES),
  scenarioId: z.string().min(1).nullable(),
  kind: z.enum(DIRECTIVE_KINDS),
  roles: z.array(z.string().min(1)),
  startsAt: epochMs,
  endsAt: epochMs.nullable(),
  timezone: z.string().min(1),
  /** The state at creation: `scheduled` for a future start, `active` otherwise. */
  state: z.enum(DIRECTIVE_STATES),
  origin: z.enum(DIRECTIVE_ORIGINS),
  ruleKey: z.string().min(1).nullable(),
  suspendsId: directiveId.nullable(),
  replacesId: directiveId.nullable(),
  /**
   * [proposta] The whole record of the new order (text, rule value and dates), so a client builds
   * its list from the events alone, with no read per event (N173, like `demand.transitioned` and
   * `decision.created`). Optional: an older log has none, and the client then reads the order.
   */
  order: DirectiveRecordSchema.optional(),
});

/**
 * `directive.activated`: the start arrived. `effectiveAt` is the real start, also when the daemon
 * only noticed it after a restart.
 */
export const DirectiveActivatedPayloadSchema = z.strictObject({
  directiveId,
  effectiveAt: epochMs,
});

/** `directive.validity_changed`: the start or the end was moved (`extend`). */
export const DirectiveValidityChangedPayloadSchema = z.strictObject({
  directiveId,
  startsAt: epochMs,
  endsAt: epochMs.nullable(),
  previousStartsAt: epochMs,
  previousEndsAt: epochMs.nullable(),
});

/** `directive.expiring`: the notice before the end (24h by default, `directives.expiring_notice`). */
export const DirectiveExpiringPayloadSchema = z.strictObject({
  directiveId,
  endsAt: epochMs,
  /** The advance the notice was configured with. */
  noticeMs: z.int().min(0),
});

/** `directive.expired`: the end arrived. `effectiveAt` is the real end (it can be in the past). */
export const DirectiveExpiredPayloadSchema = z.strictObject({
  directiveId,
  effectiveAt: epochMs,
});

/** `directive.revoked`: definitive, with the reason that is mandatory. */
export const DirectiveRevokedPayloadSchema = z.strictObject({
  directiveId,
  reason: z.string().min(1),
  revokedAt: epochMs,
});

/** `directive.suspended`: a local suspension took a global order out of one scenario. */
export const DirectiveSuspendedPayloadSchema = z.strictObject({
  /** The suspension itself. */
  directiveId,
  /** The global order that stops reaching the scenario. */
  suspendsId: directiveId,
  scenarioId: z.string().min(1),
});
