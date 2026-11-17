// SPDX-License-Identifier: MPL-2.0
import {
  buildRegistries,
  officialRegistryEntries,
  type Registries,
  type RegistryEntries,
} from '@otheater/core';
import { DAEMON_EVENT_DEFINITIONS } from '@otheater/protocol';

/**
 * The registries the daemon starts with (architecture 5.18, "Registros"): the official roles,
 * tools, `rule` keys, flows and scenario types of `@otheater/core`, and the 11 event types of
 * `@otheater/protocol`. Plugin entries join here when the plugin steps arrive.
 */
export function defaultRegistryEntries(): RegistryEntries {
  return officialRegistryEntries(DAEMON_EVENT_DEFINITIONS);
}

/**
 * Builds and validates the registries. Runs at start-up, before the store is opened: a problem
 * rejects with `InvalidInput` listing every entry that failed (registry and entry named), and
 * the daemon does not start.
 */
export function buildDaemonRegistries(
  entries: RegistryEntries = defaultRegistryEntries(),
): Registries {
  return buildRegistries(entries);
}
