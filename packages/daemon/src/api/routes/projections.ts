// SPDX-License-Identifier: MPL-2.0
import type { PlayRecord, ScenarioRecord } from '@otheater/core';
import type { ApiPlay, ApiScenario } from '@otheater/protocol';

// Apart from `scenarios.ts` (which needs the dependencies of the routes) so that the registry of the
// `/` commands can show the same projections without a cycle of imports.

/** A copy of the record without the named fields. */
function without<Row extends object, Name extends keyof Row>(
  record: Row,
  names: readonly Name[],
): Omit<Row, Name> {
  const kept = Object.entries(record).filter(([name]) => !names.includes(name as Name));
  return Object.fromEntries(kept) as Omit<Row, Name>;
}

/** The scenario as a list shows it: without the parts the detail carries. */
export const scenarioOf = (record: ScenarioRecord): ApiScenario =>
  without(record, ['conventions', 'configOverride']);

/** The play without the machine's own snapshot. */
export const playOf = (record: PlayRecord): ApiPlay => without(record, ['snapshot']);
