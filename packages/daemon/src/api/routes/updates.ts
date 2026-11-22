// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { UpdateChecker } from '../../updates/checker.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * The search for updates over REST (Phase 10, P7). [proposta] `GET /v1/updates` is the state of the
 * service (mode, channel, what was found, what is ready); `POST /v1/updates/check` searches now and
 * answers the state after the search. With `mode: off` the search is not run (409 `conflict`); a
 * daemon without the service answers 503 `unavailable`. Neither route installs anything: applying a
 * version is P8.
 */

function serviceOf(service: UpdateChecker | undefined): UpdateChecker {
  if (service === undefined) {
    throw new ApiFailure('unavailable', 'This daemon has no update service');
  }
  return service;
}

export function registerUpdateRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('getUpdateStatus', () => serviceOf(deps.updates).status());
}

export function registerUpdateCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('checkUpdates', async () => {
    const service = serviceOf(deps.updates);
    if (service.status().mode === 'off') {
      throw new ApiFailure('conflict', 'The search for updates is off (updates.mode)');
    }
    return await service.checkNow();
  });
}
