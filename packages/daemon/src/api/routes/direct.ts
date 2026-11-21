// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import { available, type CommandRegistrar } from './command.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * The reads of the direct sessions with an Actor (P19 of Phase 7; architecture 5.20). [proposta]
 * The sessions live in the memory of the daemon, so a restart ends them: a read of one that is not
 * known answers 404 `not_found`.
 */
export function registerDirectRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('listDirectSessions', async ({ params }) => ({
    sessions: await available(deps.direct, 'hold direct sessions').list(params.scenarioId),
  }));
  handlers.register('getDirectSession', ({ params }) =>
    available(deps.direct, 'hold direct sessions').get(params.sessionId),
  );
}

/**
 * The commands of the direct sessions. The failures of the service are the errors of the core, so
 * the registrar maps them: `Conflict` to 409 (a turn runs, the session is closed, too many open),
 * `QuotaExhausted` to 429, `PermissionDenied` to 403, `InvalidInput` to 400, `NotFound` to 404.
 */
export function registerDirectCommands(register: CommandRegistrar, deps: CommandRouteDeps): void {
  const direct = () => available(deps.direct, 'hold direct sessions');
  register('openDirectSession', ({ params, body }) =>
    direct().open(params.scenarioId, {
      executor: body.executor,
      workspace: body.workspace,
      confirm: body.confirm,
    }),
  );
  register('sendDirectMessage', ({ params, body }) => direct().say(params.sessionId, body.text));
  register('runDirectCommand', ({ params, body }) => direct().command(params.sessionId, body.text));
  register('cancelDirectTurn', ({ params }) => direct().cancel(params.sessionId));
  register('closeDirectSession', ({ params }) => direct().close(params.sessionId));
  register('promoteDirectSession', ({ params, body }) =>
    direct().promote(params.sessionId, { target: body.target, text: body.text }),
  );
}
