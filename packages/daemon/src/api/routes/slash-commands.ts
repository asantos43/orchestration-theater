// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * `GET /v1/commands?scenario=`: the `/` commands valid for a scenario now, those of the client of
 * the Director included (P3 of Phase 7; architecture 5.13). With `chat.slash_commands: off` the
 * list is empty. [proposta]
 */
export function registerSlashRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('listCommands', async ({ query }) => {
    const slash = available(deps.slash, 'list the / commands');
    if (!slash.enabled()) return { commands: [] };
    return {
      commands: await slash.list({ scenarioId: query.scenario, lang: query.lang }),
    };
  });
}

/**
 * `POST /v1/scenarios/:scenarioId/commands`: runs one line. A command that asks for a
 * confirmation answers `status: confirm` and does nothing until the same line comes again with
 * `confirm: true`. The failures of the registry are the errors of the core, so the registrar
 * maps them (`Conflict` to 409, `PermissionDenied` to 403, `InvalidInput` to 400).
 */
export function registerSlashCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  register('runScenarioCommand', ({ params, body }) => {
    const slash = available(deps.slash, 'run / commands');
    return slash.execute(params.scenarioId, { text: body.text, confirm: body.confirm });
  });
}
