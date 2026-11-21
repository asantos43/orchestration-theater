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

/** When an edit of the configuration takes effect: now, at the next start, or each part by its own rule. */
export const CONFIG_APPLIES_ON = ['hot', 'restart', 'mixed'] as const;

/**
 * `config.edited`: the configuration file was edited through `PUT /v1/config`. [proposta]
 * `set` and `removed` are dotted key paths (`quota.near_limit`), never values: a value could be
 * private, and the edit is in the file. `appliesOn` says whether every key was taken in at once
 * (`hot`), none was (`restart`) or some were (`mixed`): see `config.changed`.
 */
export const ConfigEditedPayloadSchema = z.strictObject({
  set: z.array(z.string().min(1)),
  removed: z.array(z.string().min(1)),
  appliesOn: z.enum(CONFIG_APPLIES_ON),
});

/**
 * `config.changed` (P16 of Phase 7, N188): the running daemon took in an edit of the configuration
 * without a restart. `hot` lists the dotted key paths that already changed behaviour (`ui.*`,
 * `chat.*`, `limits.*`, `roles.*`); `restart` lists the ones the file now holds but the daemon only
 * reads at its next start. Paths only, never values. It is not written when nothing was hot.
 */
export const ConfigChangedPayloadSchema = z.strictObject({
  hot: z.array(z.string().min(1)),
  restart: z.array(z.string().min(1)),
});
