// SPDX-License-Identifier: MPL-2.0
import { ApiFailure, type ApiHandlers } from '../handlers.js';
import type { SetupService } from '../../setup/index.js';
import type { CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/** The assistant, or 503 `unavailable` when this daemon was built without it. */
function assistant(service: SetupService | undefined): SetupService {
  if (service === undefined) {
    throw new ApiFailure('unavailable', 'This daemon runs without the setup assistant');
  }
  return service;
}

/**
 * `GET /v1/setup`: whether a first run is needed, and the run to resume in each flow (P4 of
 * docs/18); `GET /v1/setup/models/:client/:name`: the models of an account after its login (N324).
 */
export function registerSetupRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('getSetup', () => assistant(deps.setup).overview());
  // N324: after a login, whether the account is logged in and the models it can use.
  handlers.register('getSetupModels', ({ params }) =>
    assistant(deps.setup).models(`${params.client}/${params.name}`),
  );
}

/**
 * The commands of the setup assistant (P4 of docs/18): start a run of a flow, answer its current
 * step, go back, confirm and cancel; look for the clients again and install the ACP adapter of one (P18, N321). The service holds the rules (see `setup/service.ts`); the
 * events `setup.*` are written there. The registrar gives the `Idempotency-Key` and the codes of the
 * API, and the server holds each command until the reconciliation of the start-up ends.
 */
export function registerSetupCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('redetectSetupClients', () => assistant(deps.setup).redetect());
  register('installSetupAdapter', ({ params }) =>
    assistant(deps.setup).installAdapter(params.client),
  );
  register('startSetup', ({ params }) => assistant(deps.setup).start(params.flow));
  register('submitSetupStep', ({ params, body }) =>
    assistant(deps.setup).submit(params.runId, body),
  );
  register('backSetup', ({ params }) => assistant(deps.setup).back(params.runId));
  register('confirmSetup', ({ params }) => assistant(deps.setup).confirm(params.runId));
  register('cancelSetup', ({ params }) => assistant(deps.setup).cancel(params.runId));
}
