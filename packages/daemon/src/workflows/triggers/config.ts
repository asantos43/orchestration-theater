// SPDX-License-Identifier: MPL-2.0
/**
 * The keys `workflows.triggers.*` (docs/24 section 8, 9 and 12, D3, D6; plan of Phase 11b, P6).
 * The first six are the ones of the plan; the last three are [proposta] and are marked so.
 *
 * - `authors`: who may start a run from an issue or a pull request of the code host. `allowlist`
 *   (default) only the logins of `authors_list`; `collaborators` the people with a role in the
 *   repository (asked of the code host, one question per author, kept while the daemon runs); `any`
 *   anybody. The text of the item is written by a third party, so the default is the closed one.
 * - `authors_list`: the logins of the `allowlist` (default empty: nobody). The comparison ignores
 *   the case (GitHub logins are not case sensitive).
 * - `plugin_events`: `declared` (default) lets a binding ask for the event of a plugin when the
 *   three conditions of D6 hold (the plugin is installed and active in the scenario, its manifest
 *   declares the event in `triggers`, and the binding names the event); `off` never fires on a
 *   plugin event.
 * - `poll.mode`: `loop` (default) looks at the code host on a timer of the daemon's `Clock`; `off`
 *   does not look at all (no operating system trigger in any mode: D3).
 * - `poll.interval`: the time between two looks (default `5m`, at least `1m`: every look is a call
 *   to the host).
 * - `poll.on_error`: what a failed look does: `backoff` (default) waits longer and goes on (the
 *   wait doubles at each failure up to `poll.backoff_max`); `pause_binding` pauses the binding of
 *   the trigger that failed, and the Producer resumes it.
 * - `poll.backoff_max` [proposta]: the longest wait of the `backoff` (default `1h`).
 * - `poll.limit` [proposta]: how many items one look asks of the host (default 30, at most 100).
 * - `event_poll` [proposta]: how often the log is read for the internal and plugin event triggers
 *   (default `2s`, the same as `workflows.runtime.wait_event.poll`); `off` fires no event trigger.
 */
export const WORKFLOW_TRIGGER_AUTHOR_MODES = ['allowlist', 'collaborators', 'any'] as const;
export type WorkflowTriggerAuthorMode = (typeof WORKFLOW_TRIGGER_AUTHOR_MODES)[number];

export const WORKFLOW_PLUGIN_EVENT_MODES = ['declared', 'off'] as const;
export type WorkflowPluginEventMode = (typeof WORKFLOW_PLUGIN_EVENT_MODES)[number];

export const WORKFLOW_POLL_MODES = ['loop', 'off'] as const;
export type WorkflowPollMode = (typeof WORKFLOW_POLL_MODES)[number];

export const WORKFLOW_POLL_ON_ERROR_MODES = ['backoff', 'pause_binding'] as const;
export type WorkflowPollOnError = (typeof WORKFLOW_POLL_ON_ERROR_MODES)[number];

/** The shortest `poll.interval`: every look is a call to the code host (1 minute). */
export const WORKFLOW_POLL_MIN_INTERVAL_MS = 60_000;

/** Most items one look may ask of the host: what `IssueTracker.listIssues` serves. */
export const WORKFLOW_POLL_MAX_LIMIT = 100;

/** `workflows.triggers` as the triggers read it (the names are the ones of the file; times in ms). */
export interface WorkflowTriggersSettings {
  readonly authors: WorkflowTriggerAuthorMode;
  readonly authors_list: readonly string[];
  readonly plugin_events: WorkflowPluginEventMode;
  readonly poll: {
    readonly mode: WorkflowPollMode;
    readonly interval: number;
    readonly on_error: WorkflowPollOnError;
    readonly backoff_max: number;
    readonly limit: number;
  };
  /** `null` when `off`. */
  readonly event_poll: number | null;
}

/** The defaults of `workflows.triggers`, for a service built without a configuration. */
export const DEFAULT_WORKFLOW_TRIGGERS_SETTINGS: WorkflowTriggersSettings = {
  authors: 'allowlist',
  authors_list: [],
  plugin_events: 'declared',
  poll: {
    mode: 'loop',
    interval: 300_000,
    on_error: 'backoff',
    backoff_max: 3_600_000,
    limit: 30,
  },
  event_poll: 2_000,
};

/** The part of the resolved `workflows` block this module reads (structural: no import of `config.ts`). */
export interface WorkflowsConfigTriggersView {
  readonly triggers: WorkflowTriggersSettings;
}

/** `workflows.triggers` of the resolved configuration. */
export function workflowTriggersSettings(
  config: WorkflowsConfigTriggersView,
): WorkflowTriggersSettings {
  return config.triggers;
}
