// SPDX-License-Identifier: MPL-2.0
import {
  PLUGIN_ID_PATTERN,
  PLUGIN_LANGUAGE_PATTERN,
  PluginManifestSchema,
  TOOL_EFFECT_CLASSES,
} from '@otheater/core';
import { z } from 'zod';
import { ScenarioIdSchema } from './ids.js';
import { IdempotencyHeadersSchema } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The plugins of the daemon (Phase 9, P10; architecture 5.14). The Producer sees what is installed,
 * what a plugin asks for before it is turned on, turns it on and off in a project, reads the panel
 * the manifest declares and runs the actions of the panel. [proposta] Every route is on the same
 * door as the others (`/v1/*`, the same token); the project is a scenario of the daemon, and a
 * project that does not exist answers 404 `not_found`.
 *
 * The panel is drawn by the interface from data (no code of the plugin runs there): the daemon
 * calls the `source` tools of the blocks (all `effects: read`, which the manifest validator checks)
 * and sends back the rows with the texts of the plugin catalog already in the language asked.
 */

const PluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN);
const LanguageSchema = z.string().regex(PLUGIN_LANGUAGE_PATTERN).max(32);
const ManifestHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const PluginParamsSchema = z.strictObject({ pluginId: PluginIdSchema });
export const PluginActionParamsSchema = z.strictObject({
  pluginId: PluginIdSchema,
  tool: z.string().min(1).max(128),
});

/** `active`, or waiting for a new approval (the manifest changed), or its folder cannot be used. */
export const PLUGIN_PROJECT_STATE_NAMES = ['active', 'needs_approval', 'broken'] as const;

export const ApiPluginProjectSchema = z.strictObject({
  project: ScenarioIdSchema,
  state: z.enum(PLUGIN_PROJECT_STATE_NAMES),
});

/** An installed plugin, as `ot plugin list --json` shows it, with the origin as text. */
export const ApiPluginSchema = z.strictObject({
  id: PluginIdSchema,
  version: z.string().min(1),
  /** `path:<folder>`, `npm:<package>@<version>` or `git:<url>#<ref>`. */
  origin: z.string(),
  description: z.string().nullable(),
  /** The hash of the manifest registered at install or update time. */
  manifestHash: ManifestHashSchema,
  /** Why the folder cannot be used (missing, invalid manifest), or `null`. */
  problem: z.string().nullable(),
  projects: z.array(ApiPluginProjectSchema),
});
export type ApiPlugin = z.infer<typeof ApiPluginSchema>;

export const ListPluginsQuerySchema = z.strictObject({
  /** Only the plugins that have a state in this project. */
  project: ScenarioIdSchema.optional(),
});
export type ListPluginsQuery = z.input<typeof ListPluginsQuerySchema>;

export const ListPluginsResultSchema = z.strictObject({ plugins: z.array(ApiPluginSchema) });

export const listPlugins = defineRoute({
  id: 'listPlugins',
  method: 'GET',
  path: '/v1/plugins',
  summary: 'The installed plugins, with the state of each one in each project',
  query: ListPluginsQuerySchema,
  response: ListPluginsResultSchema,
});

/** What the Producer is shown before a plugin is turned on: the data of `ot plugin enable`. */
export const ApiPluginActivationSummarySchema = z.strictObject({
  id: PluginIdSchema,
  version: z.string(),
  description: z.string().nullable(),
  server: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('stdio'),
      command: z.array(z.string()),
      cwd: z.string().nullable(),
    }),
    z.strictObject({ type: z.literal('http'), url: z.string() }),
  ]),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      roles: z.array(z.string()),
      specialties: z.array(z.string()),
      effects: z.enum(TOOL_EFFECT_CLASSES),
      requiresProducerApproval: z.boolean(),
    }),
  ),
  /** The names of the secrets, never their values. */
  secrets: z.array(z.string()),
  /** The full types, `plugin.<id>.<name>`. */
  events: z.array(z.string()),
  panelBlocks: z.int().min(0),
});
export type ApiPluginActivationSummary = z.infer<typeof ApiPluginActivationSummarySchema>;

export const PluginDetailQuerySchema = z.strictObject({
  /** The language of the activation text; default: `ui.locale` of the daemon. */
  lang: LanguageSchema.optional(),
});
export type PluginDetailQuery = z.input<typeof PluginDetailQuerySchema>;

export const ApiPluginDetailSchema = ApiPluginSchema.extend({
  /**
   * The hash of the `plugin.yaml` that is on disk now: what `enable` approves. Give it back in
   * `enablePlugin` so that what is approved is what was shown.
   */
  currentManifestHash: ManifestHashSchema,
  manifest: PluginManifestSchema,
  summary: ApiPluginActivationSummarySchema,
  /** The text of `ot plugin enable`, one line per fact, in the language asked. */
  activation: z.array(z.string()),
});
export type ApiPluginDetail = z.infer<typeof ApiPluginDetailSchema>;

export const getPlugin = defineRoute({
  id: 'getPlugin',
  method: 'GET',
  path: '/v1/plugins/:pluginId',
  summary: 'One plugin: the manifest and the text of what it asks for before it is turned on',
  params: PluginParamsSchema,
  query: PluginDetailQuerySchema,
  response: ApiPluginDetailSchema,
  errors: ['not_found', 'conflict'],
});

export const EnablePluginBodySchema = z.strictObject({
  project: ScenarioIdSchema,
  /**
   * [proposta] The `currentManifestHash` the client showed. When it is given and the file changed
   * since, nothing is approved (409 `conflict`). Without it the manifest of the moment is
   * approved, as `ot plugin enable --yes` does.
   */
  manifestHash: ManifestHashSchema.optional(),
});
export type EnablePluginBody = z.input<typeof EnablePluginBodySchema>;

export const EnablePluginResultSchema = z.strictObject({
  id: PluginIdSchema,
  project: ScenarioIdSchema,
  /** `false` when the plugin was already on with this manifest. */
  changed: z.boolean(),
  manifestHash: ManifestHashSchema,
});

export const enablePlugin = defineRoute({
  id: 'enablePlugin',
  method: 'POST',
  path: '/v1/plugins/:pluginId/enable',
  summary: 'Turns a plugin on in a project, approving the manifest that was shown',
  params: PluginParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: EnablePluginBodySchema,
  response: EnablePluginResultSchema,
  errors: ['not_found', 'conflict'],
});

export const DisablePluginBodySchema = z.strictObject({ project: ScenarioIdSchema });
export type DisablePluginBody = z.input<typeof DisablePluginBodySchema>;

export const DisablePluginResultSchema = z.strictObject({
  id: PluginIdSchema,
  project: ScenarioIdSchema,
  /** `false` when the plugin was not on in the project. */
  disabled: z.boolean(),
});

export const disablePlugin = defineRoute({
  id: 'disablePlugin',
  method: 'POST',
  path: '/v1/plugins/:pluginId/disable',
  summary: 'Turns a plugin off in a project',
  params: PluginParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: DisablePluginBodySchema,
  response: DisablePluginResultSchema,
  errors: ['not_found'],
});

// ---------------------------------------------------------------------------------------------
// The panel

/** Why a block has no data: a code of the daemon, never the text of the plugin. */
export const PLUGIN_PANEL_ERROR_CODES = [
  'plugin_unavailable',
  'plugin_timeout',
  'plugin_failed',
  'tool_unavailable',
  'tool_error',
  'invalid_result',
  'not_readable',
] as const;

const PanelBlockErrorSchema = z.strictObject({
  code: z.enum(PLUGIN_PANEL_ERROR_CODES),
  message: z.string(),
});

/** The data of a block was cut: the limit of `plugins.panel` and what was there. */
const PanelTruncatedSchema = z.strictObject({
  reason: z.enum(['rows', 'bytes']),
  /** Rows (or bytes, with `reason: bytes`) the plugin sent. */
  total: z.int().min(0),
  kept: z.int().min(0),
  limit: z.int().min(0),
});

const PanelDataFields = {
  /** The tool of the plugin whose answer fills the block. */
  source: z.string(),
  error: PanelBlockErrorSchema.nullable(),
  truncated: PanelTruncatedSchema.nullable(),
};

export const ApiPanelBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('table'),
    title: z.string(),
    ...PanelDataFields,
    columns: z.array(z.strictObject({ key: z.string(), label: z.string() })),
    rows: z.array(z.record(z.string(), z.json())),
  }),
  z.strictObject({
    type: z.literal('list'),
    title: z.string(),
    ...PanelDataFields,
    items: z.array(z.json()),
  }),
  z.strictObject({
    type: z.literal('metrics'),
    title: z.string(),
    ...PanelDataFields,
    metrics: z.array(z.strictObject({ key: z.string(), value: z.json() })),
  }),
  z.strictObject({
    type: z.literal('action'),
    label: z.string(),
    /** The tool the click runs (`POST .../actions/:tool`). */
    tool: z.string(),
    /** Whether the call waits for the Producer: `none`, `manifest` or `policy` (as P6 says). */
    approval: z.enum(['none', 'manifest', 'policy']),
  }),
]);
export type ApiPanelBlock = z.infer<typeof ApiPanelBlockSchema>;

export const PluginPanelQuerySchema = z.strictObject({
  project: ScenarioIdSchema,
  /** The language of the texts; default: `ui.locale` of the daemon. What the plugin lacks shows in `en`. */
  lang: LanguageSchema.optional(),
});
export type PluginPanelQuery = z.input<typeof PluginPanelQuerySchema>;

export const ApiPluginPanelSchema = z.strictObject({
  plugin: PluginIdSchema,
  project: ScenarioIdSchema,
  /** The language of the texts that came: the one asked, or `en` where the plugin has no catalog. */
  language: z.string(),
  blocks: z.array(ApiPanelBlockSchema),
});
export type ApiPluginPanel = z.infer<typeof ApiPluginPanelSchema>;

export const getPluginPanel = defineRoute({
  id: 'getPluginPanel',
  method: 'GET',
  path: '/v1/plugins/:pluginId/panel',
  summary: 'The panel of a plugin in a project: the blocks with their data and texts',
  params: PluginParamsSchema,
  query: PluginPanelQuerySchema,
  response: ApiPluginPanelSchema,
  errors: ['not_found', 'conflict'],
});

export const PluginActionBodySchema = z.strictObject({ project: ScenarioIdSchema });
export type PluginActionBody = z.input<typeof PluginActionBodySchema>;

export const PluginActionResultSchema = z.strictObject({
  plugin: PluginIdSchema,
  project: ScenarioIdSchema,
  tool: z.string(),
  /** `false` when the call reached the plugin and it answered a tool error, or did not answer. */
  ok: z.boolean(),
  /** What the tool answered (JSON, or its text when it is not JSON); `null` with `ok: false`. */
  result: z.json().nullable(),
  /** The result was bigger than `plugins.panel.max_bytes` and is not sent (`result` is `null`). */
  truncated: PanelTruncatedSchema.nullable(),
  error: PanelBlockErrorSchema.nullable(),
});
export type PluginActionResult = z.infer<typeof PluginActionResultSchema>;

export const callPluginAction = defineRoute({
  id: 'callPluginAction',
  method: 'POST',
  path: '/v1/plugins/:pluginId/actions/:tool',
  summary:
    'Runs an action of the panel for the Producer; it asks the Producer first when the tool needs it',
  params: PluginActionParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: PluginActionBodySchema,
  response: PluginActionResultSchema,
  errors: ['not_found', 'conflict', 'forbidden', 'unavailable'],
});

export const PLUGIN_ROUTES = defineRoutes(
  listPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  getPluginPanel,
  callPluginAction,
);
