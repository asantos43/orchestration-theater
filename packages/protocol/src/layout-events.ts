// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { LAYOUT_REPLACE_REASONS, LayoutInterfaceSchema } from './api/layout.js';

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
