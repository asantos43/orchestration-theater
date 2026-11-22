// SPDX-License-Identifier: MPL-2.0
import type { ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  ApiPanelBlockSchema,
  ApiPluginPanelSchema,
  defineRoute,
  type ApiPlugin,
  type ApiPluginDetail,
  type ApiPluginPanel,
  type PluginActionResult,
  type RouteResponse,
} from '@otheater/protocol';
import { randomUUID } from 'node:crypto';
import { UNREADABLE_BLOCK } from './model.js';

/**
 * What the tab Plugins asks of the daemon (P11 of Phase 9): the thin, typed face of the routes of
 * P10, so a test can put a fake in its place and the screen never sees the client. There is no
 * route that writes a secret (P10 made none), so none is here: the tab only shows what is missing
 * and the command that sets it. [proposta] Every command carries its own `Idempotency-Key`: a
 * retry of the client does not repeat the effect, and two presses of a key are two commands.
 */
export interface PluginsApi {
  /** Every plugin installed, with its state in each project. */
  list(): Promise<readonly ApiPlugin[]>;
  /** The manifest and the text of what the plugin asks for, in the language given. */
  detail(pluginId: string, language: string | undefined): Promise<ApiPluginDetail>;
  /** The panel of an active plugin in a project. */
  panel(pluginId: string, project: string, language: string | undefined): Promise<ApiPluginPanel>;
  enable(
    pluginId: string,
    project: string,
    manifestHash: string,
  ): Promise<RouteResponse<typeof API_ROUTES.enablePlugin>>;
  disable(
    pluginId: string,
    project: string,
  ): Promise<RouteResponse<typeof API_ROUTES.disablePlugin>>;
  /** Runs an action block of the panel; the daemon waits for the Producer when the tool asks for it. */
  action(pluginId: string, tool: string, project: string): Promise<PluginActionResult>;
}

function key(): { readonly 'idempotency-key': string } {
  return { 'idempotency-key': randomUUID() };
}

/**
 * The route of the panel with a block it cannot read kept as a mark ({@link UNREADABLE_BLOCK}),
 * not as a failure of the whole answer: a block of a type this screen does not know (a newer
 * daemon) or one that does not fit the contract is shown as unreadable and the rest is drawn.
 * [proposta] The envelope (`plugin`, `project`, `language`, `blocks`) stays strict.
 */
const lenientPanelRoute = defineRoute({
  id: 'getPluginPanel',
  method: 'GET',
  path: '/v1/plugins/:pluginId/panel',
  summary: API_ROUTES.getPluginPanel.summary,
  params: API_ROUTES.getPluginPanel.params,
  query: API_ROUTES.getPluginPanel.query,
  response: ApiPluginPanelSchema.extend({
    blocks: ApiPanelBlockSchema.catch(() => UNREADABLE_BLOCK).array(),
  }),
  errors: ['not_found', 'conflict'],
});

/** A language the daemon accepts (`en`, `pt-BR`); anything else is left out and the daemon picks. */
export function languageParam(language: string | undefined): { lang?: string } {
  return language !== undefined && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)
    ? { lang: language }
    : {};
}

/** The plugins API over the typed client of the daemon. */
export function apiOf(client: ApiClient): PluginsApi {
  return {
    list: async () => (await client.call(API_ROUTES.listPlugins, { query: {} })).plugins,
    detail: (pluginId, language) =>
      client.call(API_ROUTES.getPlugin, {
        params: { pluginId },
        query: languageParam(language),
      }),
    panel: (pluginId, project, language) =>
      client.call(lenientPanelRoute, {
        params: { pluginId },
        query: { project, ...languageParam(language) },
      }),
    enable: (pluginId, project, manifestHash) =>
      client.call(API_ROUTES.enablePlugin, {
        params: { pluginId },
        body: { project, manifestHash },
        headers: key(),
      }),
    disable: (pluginId, project) =>
      client.call(API_ROUTES.disablePlugin, {
        params: { pluginId },
        body: { project },
        headers: key(),
      }),
    action: (pluginId, tool, project) =>
      client.call(API_ROUTES.callPluginAction, {
        params: { pluginId, tool },
        body: { project },
        headers: key(),
      }),
  };
}
