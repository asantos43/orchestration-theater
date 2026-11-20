// SPDX-License-Identifier: MPL-2.0
import { ScenarioRefSchema, type ScenarioRef } from '@otheater/protocol';

/**
 * Helpers for the global reference of a scenario (N168). A scenario id (`S1`) is unique only in
 * one daemon, so everything in the client names a scenario by `{ daemonId, scenarioId }`.
 */

/**
 * A string for a `Map` key or a React key: both parts, never the scenario id alone. A UUID has no
 * `/`, so the key is unambiguous even for an odd scenario id.
 */
export function scenarioRefKey(ref: ScenarioRef): string {
  return `${ref.daemonId}/${ref.scenarioId}`;
}

/** The reference of a key made by {@link scenarioRefKey}, or `undefined` when it is not one. */
export function parseScenarioRefKey(key: string): ScenarioRef | undefined {
  const at = key.indexOf('/');
  if (at < 0) return undefined;
  const parsed = ScenarioRefSchema.safeParse({
    daemonId: key.slice(0, at),
    scenarioId: key.slice(at + 1),
  });
  return parsed.success ? parsed.data : undefined;
}

export function sameScenario(a: ScenarioRef, b: ScenarioRef): boolean {
  return a.daemonId === b.daemonId && a.scenarioId === b.scenarioId;
}
