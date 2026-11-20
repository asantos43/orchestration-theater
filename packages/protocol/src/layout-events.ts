// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import {
  LAYOUT_REPLACE_REASONS,
  LayoutInterfaceSchema,
  LayoutOriginSchema,
  LayoutPreferencesSchema,
} from './api/layout.js';

/**
 * Payload of the event the layout preferences write when a saved record is not used as it was
 * (Phase 6, P12 of docs/17). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at
 * `schemaVersion` 1.
 *
 * `layout.adjusted`: on start, the daemon found the record of an interface in an old version (it
 * was moved up to the current one: `migrated`) or one it cannot use (a newer version, damaged or
 * outside the schema: `replaced` by the default). [proposta] The values of the record are not in
 * the payload. A record that is replaced is kept next to the original under another name
 * (`kept: true`), so nothing is lost without trace; `fromVersion` is `null` when no version could
 * be read.
 */
export const LayoutAdjustedPayloadSchema = z.strictObject({
  interface: LayoutInterfaceSchema,
  action: z.enum(['migrated', 'replaced']),
  /** Why it was replaced; `null` for a migration. */
  reason: z.enum(LAYOUT_REPLACE_REASONS).nullable(),
  fromVersion: z.int().min(1).nullable(),
  /** A copy of the unusable record was kept beside it. */
  kept: z.boolean(),
});

/**
 * Payload of `layout.changed` (N174, 2026-11-20; schemaVersion 1): a `PUT /v1/layout/:interface`
 * changed the record of an interface, so another client that follows it (`ui.layout.sync: live`)
 * can apply it without a trip to the REST. [proposta] The rules:
 * - the whole record goes in `layout`: it is a few hundred bytes. The `version` inside it is the
 *   version of the record's schema; there is no separate revision counter, because one that starts
 *   again with the daemon would mislead a client, and the id of the event in the log already orders
 *   the changes. A new `LAYOUT_VERSION` asks for a new `schemaVersion` of this event;
 * - `origin` is the `X-OT-Client-Id` of the request that wrote it, or `null` when it had none, so the
 *   client that wrote recognizes its own echo;
 * - no `scenarioId`: a layout belongs to the person, not to a scenario. A stream that filters by
 *   `scenario` does not receive it (events without a scenario never match that filter), so a
 *   client asks for it in a stream of its own (`types=layout.changed`).
 */
export const LayoutChangedPayloadSchema = z.strictObject({
  interface: LayoutInterfaceSchema,
  origin: LayoutOriginSchema.nullable(),
  layout: LayoutPreferencesSchema,
});
