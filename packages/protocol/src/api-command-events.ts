// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events the REST commands write when no service of the daemon does it for them
 * (Phase 6, P6 of docs/17). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at
 * `schemaVersion` 1. Every payload is a strict object and none carries a value a client sent:
 * only ids, kinds and the paths of the keys that changed.
 */

/**
 * `scenario.decision_answered`: the Producer answered a pending decision through
 * `POST /v1/decisions/:decisionId/answer`. [proposta] The answer itself is not in the payload (it
 * is in the decision record, which a client reads); this event is the trace that the command ran.
 * An answer given through the chat (`/chat/answer`, the socket) does not write it.
 */
export const ScenarioDecisionAnsweredPayloadSchema = z.strictObject({
  scenarioId: z.string().min(1),
  decisionId: z.string().min(1),
  /** The kind of the decision (`question`, `menu`, `recovery`, an idea group...). */
  kind: z.string().min(1),
  playId: z.string().min(1).nullable(),
});

/**
 * `config.edited`: the configuration file was edited through `PUT /v1/config`. [proposta]
 * `set` and `removed` are dotted key paths (`quota.near_limit`), never values: a value could be
 * private, and the edit is in the file. `appliesOn` is always `restart`: the running daemon keeps
 * the configuration it started with.
 */
export const ConfigEditedPayloadSchema = z.strictObject({
  set: z.array(z.string().min(1)),
  removed: z.array(z.string().min(1)),
  appliesOn: z.literal('restart'),
});
