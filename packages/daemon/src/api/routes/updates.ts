// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import { ApplyRefusal } from '../../updates/apply/coordinator.js';
import type { UpdateChecker } from '../../updates/checker.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * The search for updates over REST (Phase 10, P7). [proposta] `GET /v1/updates` is the state of the
 * service (mode, channel, what was found, what is ready); `POST /v1/updates/check` searches now and
 * answers the state after the search. With `mode: off` the search is not run (409 `conflict`); a
 * daemon without the service answers 503 `unavailable`. `POST /v1/updates/apply` (P8) asks to apply
 * the version that is ready (`how`: `default`, `park` or `wait`); it answers the status at once,
 * and the apply goes on in the background, because it ends with the daemon stopping. Nothing to
 * apply, a mode that downloads nothing, a checkout or an apply already going on answer 409.
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

  register('applyUpdate', ({ body }) => {
    const coordinator = deps.updateApply;
    if (coordinator === undefined) {
      throw new ApiFailure('unavailable', 'This daemon cannot apply updates');
    }
    try {
      coordinator.request(body.how);
    } catch (error) {
      if (error instanceof ApplyRefusal) throw new ApiFailure(error.code, error.message);
      throw error;
    }
    return serviceOf(deps.updates).status();
  });
}
