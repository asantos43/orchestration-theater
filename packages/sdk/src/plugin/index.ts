// SPDX-License-Identifier: MPL-2.0
/**
 * `@otheater/sdk/plugin`: what the author of a plugin writes the server with (architecture 5.14;
 * plan of Phase 9, P9). A plugin is an MCP server plus the manifest `plugin.yaml`; this entry has
 * the server side and keeps out of the test runner, so a plugin that ships to users does not
 * load Vitest. The conformance suite of a plugin is in `@otheater/sdk` (`describePluginConformance`).
 *
 * ```ts
 * import { definePlugin, pluginTool, readPluginManifest, servePlugin } from '@otheater/sdk/plugin';
 *
 * servePlugin(
 *   definePlugin({
 *     manifest: readPluginManifest(new URL('../plugin.yaml', import.meta.url)),
 *     tools: { hello: pluginTool({ handler: () => 'hello' }) },
 *   }),
 * );
 * ```
 */
export {
  definePlugin,
  PluginDefinitionError,
  pluginTool,
  type DefinePluginOptions,
  type PluginDefinition,
  type PluginTool,
  type PluginToolContext,
} from './define.js';
export { PLUGIN_PROJECT_DIR_ENV, pluginProjectDirectory } from './environment.js';
export {
  createEventPublisher,
  PLUGIN_EVENT_MAX_BYTES,
  PLUGIN_EVENT_METHOD,
  PluginEventError,
  type PluginEventErrorCode,
  type PluginEventParams,
  type PluginEventPublisher,
  type PluginEventPublisherOptions,
} from './events.js';
export { PluginManifestError, readPluginManifest } from './manifest-file.js';
export {
  servePlugin,
  toolAnnotations,
  type PluginServerHandle,
  type PluginServerOptions,
} from './server.js';
export type { PluginManifest, PluginManifestInput, PluginToolManifest } from '@otheater/core';
