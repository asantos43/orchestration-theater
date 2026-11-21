// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerAttemptCommands } from './attempt-commands.js';
import { registerBlackboardRoutes } from './blackboard.js';
import { registerConfigRoutes } from './config-view.js';
import { commandRegistrar } from './command.js';
import { registerConfigCommands } from './config-commands.js';
import { registerDecisionCommands } from './decision-commands.js';
import type { CommandRouteDeps, ReadRouteDeps } from './deps.js';
import { registerExecutorRoutes } from './executors.js';
import { registerIdeaCommands } from './idea-commands.js';
import { registerIdeaRoutes } from './ideas.js';
import { IdempotencyCache } from './idempotency.js';
import { registerLayoutCommands, registerLayoutRoutes } from './layout.js';
import { registerOrderCommands } from './order-commands.js';
import { registerOrderRoutes } from './orders.js';
import { registerPlayCommands } from './play-commands.js';
import { registerProfileCommands } from './profile-commands.js';
import { registerProfileRoutes } from './profiles.js';
import { registerScenarioCommands } from './scenario-commands.js';
import { registerScenarioRoutes } from './scenarios.js';
import { registerSlashCommands, registerSlashRoutes } from './slash-commands.js';
import { registerSetupCommands, registerSetupRoutes } from './setup.js';
import { registerTrajectoryRoutes } from './trajectories.js';
import { registerUsageRoutes } from './usage.js';

export type { CommandRouteDeps, ReadRouteDeps } from './deps.js';

/**
 * Registers the handlers of the read routes (GET) of the REST API (P5 of docs/17), one file per
 * resource. [proposta] The commands of P6 are registered the same way, by one `register...` per
 * resource file, called from where this one is called.
 */
export function registerReadRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  registerScenarioRoutes(handlers, deps);
  registerBlackboardRoutes(handlers, deps);
  registerAttachmentRoutes(handlers, deps);
  registerProfileRoutes(handlers, deps);
  registerExecutorRoutes(handlers, deps);
  registerOrderRoutes(handlers, deps);
  registerIdeaRoutes(handlers, deps);
  registerUsageRoutes(handlers, deps);
  registerConfigRoutes(handlers, deps);
  registerLayoutRoutes(handlers, deps);
  registerSlashRoutes(handlers, deps);
  registerSetupRoutes(handlers, deps);
  registerTrajectoryRoutes(handlers, deps);
}

/**
 * Registers the handlers of the commands (POST, PUT, DELETE) of the REST API (P6 of docs/17), one
 * file per resource, all through one {@link commandRegistrar}: the failures of the services become
 * the codes of the API and an `Idempotency-Key` makes a repeat answer the first run. The server
 * holds each of them until the reconciliation of the start-up ends (they are commands).
 */
export function registerCommandRoutes(handlers: ApiHandlers, deps: CommandRouteDeps): void {
  const cache = new IdempotencyCache({ clock: deps.clock, ttlMs: deps.idempotencyTtlMs });
  const register = commandRegistrar(handlers, cache, deps.logger);
  registerScenarioCommands(register, deps);
  registerDecisionCommands(register, deps);
  registerPlayCommands(register, deps);
  registerAttemptCommands(register, deps);
  registerOrderCommands(register, deps);
  registerIdeaCommands(register, deps);
  registerProfileCommands(register, deps);
  registerConfigCommands(register, deps);
  registerLayoutCommands(register, deps);
  registerSlashCommands(register, deps);
  registerSetupCommands(register, deps);
}
