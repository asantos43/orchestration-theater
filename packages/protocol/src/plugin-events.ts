// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events the daemon writes about the plugins (Phase 9, P8; architecture 5.14).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. [proposta]
 * The names and the fields.
 *
 * The event types are `plugin.<name>` (two segments); a plugin's own events are `plugin.<id>.<name>`
 * (three or more) and are not in this registry: the daemon makes them from the manifest of each
 * active plugin. A plugin id cannot be one of these names, so the two never meet.
 *
 * None of them carries what a plugin says or does: no argument or result of a tool, no payload of an
 * event, no value of a secret. They carry ids, names, counts and the reason the daemon gives, which
 * is masked and cut. The project of a fact is the one the plugin is on in (`project`), which is also
 * the `scenarioId` of the envelope when the event is about one project.
 */

const id = z.string().min(1).max(256);
/** A plugin id, as the manifest allows it. */
const pluginId = z.string().min(1).max(64);
const text = z.string().min(1).max(512);

/** `plugin.installed`: a plugin entered the registry (`update`: the same id with another manifest). */
export const PluginInstalledPayloadSchema = z.strictObject({
  plugin: pluginId,
  version: z.string().min(1).max(64),
  update: z.boolean(),
});
export type PluginInstalledPayload = z.infer<typeof PluginInstalledPayloadSchema>;

/** `plugin.removed`: a plugin left the registry. */
export const PluginRemovedPayloadSchema = z.strictObject({
  plugin: pluginId,
  version: z.string().min(1).max(64),
});
export type PluginRemovedPayload = z.infer<typeof PluginRemovedPayloadSchema>;

/** `plugin.enabled`: the plugin was turned on in a project. */
export const PluginEnabledPayloadSchema = z.strictObject({ plugin: pluginId, project: id });
export type PluginEnabledPayload = z.infer<typeof PluginEnabledPayloadSchema>;

/** Why a plugin stopped being on in a project: the Producer turned it off, or its manifest changed. */
export const PLUGIN_DISABLED_REASONS = ['producer', 'needs_approval'] as const;
export type PluginDisabledReason = (typeof PLUGIN_DISABLED_REASONS)[number];

/** `plugin.disabled`: the plugin is off in a project (`needs_approval`: until the new manifest is approved). */
export const PluginDisabledPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  reason: z.enum(PLUGIN_DISABLED_REASONS),
});
export type PluginDisabledPayload = z.infer<typeof PluginDisabledPayloadSchema>;

/** `plugin.server_started`: the process of the plugin started in a project (`pid` for `stdio`). */
export const PluginServerStartedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  pid: z.int().min(0).optional(),
});
export type PluginServerStartedPayload = z.infer<typeof PluginServerStartedPayloadSchema>;

/** Why a server was stopped on purpose (a failure is `plugin.server_failed`). */
export const PLUGIN_SERVER_STOP_REASONS = ['idle', 'shutdown', 'inactive', 'replaced'] as const;
export type PluginServerStopReason = (typeof PLUGIN_SERVER_STOP_REASONS)[number];

/** `plugin.server_stopped`. */
export const PluginServerStoppedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  reason: z.enum(PLUGIN_SERVER_STOP_REASONS),
});
export type PluginServerStoppedPayload = z.infer<typeof PluginServerStoppedPayloadSchema>;

/**
 * `plugin.server_failed`: a start failed or a running process died. `givenUp` is the final fall
 * (`plugins.max_restarts`): the server stays stopped until it is reset; otherwise `retryInMs` says
 * when the next use may start it again.
 */
export const PluginServerFailedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  failures: z.int().min(1),
  givenUp: z.boolean(),
  retryInMs: z.int().min(0).optional(),
  reason: text,
});
export type PluginServerFailedPayload = z.infer<typeof PluginServerFailedPayloadSchema>;

/**
 * Why a tool of a plugin stays out: the server exposes one the manifest does not declare
 * (`not_declared`), the manifest declares one the server does not expose (`not_exposed`), or the name
 * `<id>__<tool>` is too long or taken (`name_too_long`, `name_taken`). A call refused by the
 * permissions (P6, N237): the role may not call the tool (`not_allowed`), or the Producer refused,
 * could not be asked or cancelled the approval (`approval_denied`, `approval_unavailable`,
 * `approval_cancelled`). [proposta]
 */
export const PLUGIN_TOOL_REJECTED_REASONS = [
  'not_declared',
  'not_exposed',
  'name_too_long',
  'name_taken',
  'not_allowed',
  'approval_denied',
  'approval_unavailable',
  'approval_cancelled',
] as const;
export type PluginToolRejectedReason = (typeof PLUGIN_TOOL_REJECTED_REASONS)[number];

/** `plugin.tool_rejected`. `role` comes with a call the permissions refused. */
export const PluginToolRejectedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  tool: z.string().min(1).max(128),
  reason: z.enum(PLUGIN_TOOL_REJECTED_REASONS),
  role: z.string().min(1).max(64).optional(),
});
export type PluginToolRejectedPayload = z.infer<typeof PluginToolRejectedPayloadSchema>;

/**
 * Why an event a plugin published was refused: the name is not in its manifest (`not_declared`), the
 * payload is over `plugins.event_max_bytes` (`too_large`), the notification is not a name and a JSON
 * object (`invalid`), the plugin is not active in the project (`inactive`), or `plugins.events` is
 * `off` (`off`).
 */
export const PLUGIN_EVENT_REJECTED_REASONS = [
  'not_declared',
  'too_large',
  'invalid',
  'inactive',
  'off',
] as const;
export type PluginEventRejectedReason = (typeof PLUGIN_EVENT_REJECTED_REASONS)[number];

/**
 * `plugin.event_rejected`. `name` is what the plugin sent (cut; left out when it was not a string),
 * and the payload is never copied. `bytes` and `limit` come with `too_large`.
 */
export const PluginEventRejectedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  name: z.string().min(1).max(128).optional(),
  reason: z.enum(PLUGIN_EVENT_REJECTED_REASONS),
  bytes: z.int().min(0).optional(),
  limit: z.int().min(0).optional(),
});
export type PluginEventRejectedPayload = z.infer<typeof PluginEventRejectedPayloadSchema>;

/**
 * `plugin.secret_missing` (P7, N239): a server of the plugin was about to start and a secret its
 * manifest declares is not in the vault. Only the names go out, never a value. [proposta]
 */
export const PluginSecretMissingPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  secrets: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .min(1)
    .max(64),
});
export type PluginSecretMissingPayload = z.infer<typeof PluginSecretMissingPayloadSchema>;

/** Why the data of a block of the panel was cut: more rows than `plugins.panel.max_rows`, or more bytes than `plugins.panel.max_bytes`. */
export const PLUGIN_PANEL_TRUNCATED_REASONS = ['rows', 'bytes'] as const;
export type PluginPanelTruncatedReason = (typeof PLUGIN_PANEL_TRUNCATED_REASONS)[number];

/**
 * `plugin.panel_truncated` (P10, [proposta]): the answer of the `source` tool of a block was bigger
 * than the limit of the panel, so the daemon cut it and said so. `source` is the name of the tool,
 * `kept` what stayed and `total` what the plugin sent (rows with `reason: rows`, bytes with `bytes`),
 * `limit` the value of the key. Never the data itself.
 */
export const PluginPanelTruncatedPayloadSchema = z.strictObject({
  plugin: pluginId,
  project: id,
  source: z.string().min(1).max(128),
  reason: z.enum(PLUGIN_PANEL_TRUNCATED_REASONS),
  total: z.int().min(0),
  kept: z.int().min(0),
  limit: z.int().min(0),
});
export type PluginPanelTruncatedPayload = z.infer<typeof PluginPanelTruncatedPayloadSchema>;
