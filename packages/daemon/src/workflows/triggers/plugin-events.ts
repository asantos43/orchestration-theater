// SPDX-License-Identifier: MPL-2.0
import type { WorkflowTriggerSkipReason } from '@otheater/protocol';
import type { WorkflowTriggersSettings } from './config.js';

/**
 * The events of the plugins as triggers (D6; plan of Phase 11b, P6). A plugin event
 * (`plugin.<id>.<name>`) starts a workflow only when all three conditions hold:
 *
 * 1. the plugin is installed and active in the scenario of the binding (the registry of the
 *    plugins says so), and `workflows.triggers.plugin_events` is `declared` (`off` never fires on
 *    a plugin event);
 * 2. the manifest of the plugin declares the event as a trigger (the optional `triggers` field:
 *    an event in `events` but not in `triggers` is for the panel and the log, not for a workflow);
 * 3. the binding asks for the event by its name (the `event` trigger with that `filter.name`).
 *
 * The third condition is what finds the binding in the first place, so this module judges the
 * first two. The daemon's own `plugin.installed`, `plugin.server_started`... have no plugin id in
 * them (two parts, not three): they are internal events, and not judged here.
 */

/** A plugin event type split in the id of the plugin and the name the manifest declares. */
export function parsePluginEventType(
  type: string,
): { readonly pluginId: string; readonly name: string } | undefined {
  const match = /^plugin\.([a-z0-9][a-z0-9_-]*)\.(.+)$/.exec(type);
  if (match === null) return undefined;
  const [, pluginId, name] = match;
  return pluginId === undefined || name === undefined ? undefined : { pluginId, name };
}

/** What the gate reads of the registry of the plugins (`PluginRegistry.activeFor`). */
export interface ActivePluginReader {
  activeFor(project: string): readonly {
    readonly id: string;
    readonly manifest: { readonly triggers?: readonly string[] | undefined };
  }[];
}

export type PluginEventVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: Extract<
        WorkflowTriggerSkipReason,
        'plugin_events_off' | 'plugin_inactive' | 'undeclared'
      >;
      readonly detail: string;
    };

export interface PluginEventGateDeps {
  readonly settings: () => Pick<WorkflowTriggersSettings, 'plugin_events'>;
  readonly plugins: ActivePluginReader;
}

/** Whether the event of a plugin may start the binding of `scenarioId` (conditions 1 and 2 of D6). */
export function checkPluginEvent(
  deps: PluginEventGateDeps,
  scenarioId: string,
  event: { readonly pluginId: string; readonly name: string },
): PluginEventVerdict {
  if (deps.settings().plugin_events === 'off') {
    return {
      ok: false,
      reason: 'plugin_events_off',
      detail: 'workflows.triggers.plugin_events is off',
    };
  }
  const plugin = deps.plugins.activeFor(scenarioId).find((active) => active.id === event.pluginId);
  if (plugin === undefined) {
    return {
      ok: false,
      reason: 'plugin_inactive',
      detail: `the plugin ${event.pluginId} is not installed and active in the scenario`,
    };
  }
  if (!(plugin.manifest.triggers ?? []).includes(event.name)) {
    return {
      ok: false,
      reason: 'undeclared',
      detail: `the manifest of ${event.pluginId} does not declare "${event.name}" in "triggers"`,
    };
  }
  return { ok: true };
}
