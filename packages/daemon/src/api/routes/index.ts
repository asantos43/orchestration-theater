// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerBlackboardRoutes } from './blackboard.js';
import { registerConfigRoutes } from './config-view.js';
import type { ReadRouteDeps } from './deps.js';
import { registerExecutorRoutes } from './executors.js';
import { registerIdeaRoutes } from './ideas.js';
import { registerOrderRoutes } from './orders.js';
import { registerProfileRoutes } from './profiles.js';
import { registerScenarioRoutes } from './scenarios.js';
import { registerUsageRoutes } from './usage.js';

export type { ReadRouteDeps } from './deps.js';

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
}
