// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Global identifiers (decision N168, plan docs/17 P1). Scenarios, plays and demands have ids that
 * are unique only inside one daemon (`S<n>`, `P<n>`, `D<n>`), so a client that talks to several
 * daemons names a scenario by the pair `{ daemonId, scenarioId }`.
 */

/** The id of a daemon: a UUID made on the first start and kept in its data folder. */
export const DaemonIdSchema = z.uuid();
export type DaemonId = z.infer<typeof DaemonIdSchema>;

/** The id of a scenario inside one daemon. Opaque: a client never builds or splits it. */
export const ScenarioIdSchema = z.string().min(1).max(256);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/** A scenario of a given daemon: the global reference. */
export const ScenarioRefSchema = z.strictObject({
  daemonId: DaemonIdSchema,
  scenarioId: ScenarioIdSchema,
});
export type ScenarioRef = z.infer<typeof ScenarioRefSchema>;
