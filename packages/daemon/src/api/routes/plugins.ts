// SPDX-License-Identifier: MPL-2.0
import { NotFound, type Store } from '@otheater/core';
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { PluginPanelService } from '../../plugins/panel.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * The plugins of the daemon over REST (Phase 9, P10). [proposta] The project of a plugin is a
 * scenario: one that does not exist answers 404 `not_found` (turning a plugin off is the exception,
 * so what a deleted scenario left behind can be cleaned). The errors of the routes carry the
 * message of the registry and of the service, never a value of an argument of a call.
 */

function serviceOf(service: PluginPanelService | undefined): PluginPanelService {
  if (service === undefined) {
    throw new ApiFailure('unavailable', 'This daemon has no plugin service');
  }
  return service;
}

async function knownProject(store: Store, project: string): Promise<void> {
  if ((await store.scenarios.get(project)) === undefined) {
    throw new NotFound(`There is no scenario "${project}"`);
  }
}

export function registerPluginRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('listPlugins', async ({ query }) => ({
    plugins: await serviceOf(deps.plugins).list(query.project),
  }));
  handlers.register('getPlugin', async ({ params, query }) =>
    serviceOf(deps.plugins).detail(params.pluginId, query.lang),
  );
  handlers.register('getPluginPanel', async ({ params, query, signal }) => {
    const service = serviceOf(deps.plugins);
    await knownProject(deps.store, query.project);
    return await service.panel(params.pluginId, query.project, query.lang, signal);
  });
}

export function registerPluginCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('enablePlugin', async ({ params, body }) => {
    const service = serviceOf(deps.plugins);
    await knownProject(deps.store, body.project);
    return await service.enable(params.pluginId, body.project, body.manifestHash);
  });
  register('disablePlugin', async ({ params, body }) =>
    serviceOf(deps.plugins).disable(params.pluginId, body.project),
  );
  register('callPluginAction', async ({ params, body, signal }) => {
    const service = serviceOf(deps.plugins);
    await knownProject(deps.store, body.project);
    return await service.action(params.pluginId, params.tool, body.project, signal);
  });
}
