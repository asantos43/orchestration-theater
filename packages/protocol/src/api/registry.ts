// SPDX-License-Identifier: MPL-2.0
import { ADMIN_ROUTES } from './admin.js';
import { CHAT_ROUTES } from './chat.js';
import { LAYOUT_ROUTES } from './layout.js';
import { assertUniqueRoutes, type AnyApiRoute } from './route.js';
import { EVENT_ROUTES } from './sse.js';
import { STATUS_ROUTES } from './status.js';
import { ATTACHMENT_ROUTES } from './attachments.js';
import { ATTEMPT_ROUTES } from './attempts.js';
import { BLACKBOARD_ROUTES } from './blackboard.js';
import { SLASH_COMMAND_ROUTES } from './commands.js';
import { CONFIG_VIEW_ROUTES } from './config-view.js';
import { DECISION_ROUTES } from './decisions.js';
import { EXECUTOR_ROUTES } from './executors.js';
import { IDEA_ROUTES } from './ideas.js';
import { ORDER_ROUTES } from './orders.js';
import { PLAY_ROUTES } from './plays.js';
import { PROFILE_ROUTES } from './profiles.js';
import { SCENARIO_ROUTES } from './scenarios.js';
import { SETUP_ROUTES } from './setup.js';
import { USAGE_ROUTES } from './usage.js';

/**
 * Every route of the daemon API, keyed by `id`. A resource keeps its routes in its own file of
 * this folder (`status.ts`, `sse.ts`, `chat.ts`, `layout.ts`, `admin.ts`; P5 and P6 add `scenarios.ts` and
 * the others) and spreads its table here. The server (P3 and later) and the client (P9) read
 * routes from here, and the catalog (`catalog.ts`) is generated from it.
 */
export const API_ROUTES = {
  ...STATUS_ROUTES,
  ...EVENT_ROUTES,
  ...CHAT_ROUTES,
  ...LAYOUT_ROUTES,
  ...ADMIN_ROUTES,
  ...ATTACHMENT_ROUTES,
  ...ATTEMPT_ROUTES,
  ...BLACKBOARD_ROUTES,
  ...CONFIG_VIEW_ROUTES,
  ...DECISION_ROUTES,
  ...EXECUTOR_ROUTES,
  ...IDEA_ROUTES,
  ...ORDER_ROUTES,
  ...PLAY_ROUTES,
  ...PROFILE_ROUTES,
  ...SCENARIO_ROUTES,
  ...SETUP_ROUTES,
  ...USAGE_ROUTES,
  ...SLASH_COMMAND_ROUTES,
} as const;

export type ApiRouteId = keyof typeof API_ROUTES;

/** The routes as a list, ordered by id. */
export const API_ROUTE_LIST: readonly AnyApiRoute[] = Object.values(API_ROUTES).sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);

// A clash is a mistake of the author: fail when the module loads, not in production.
assertUniqueRoutes(API_ROUTE_LIST);
