// SPDX-License-Identifier: MPL-2.0
import type { ToolHandler, ToolHandlers } from '../mcp/handlers.js';
import { commandToolHandlers } from './command-tools.js';
import { ToolsContext, type ToolsDeps } from './context.js';
import { gitToolHandlers } from './git-tools.js';
import { httpToolHandlers } from './http-get.js';

export { nodePathHost } from './host.js';
export { ToolsContext, ToolRefusal, ToolTimeout, type ToolsDeps } from './context.js';
export { Semaphore } from './semaphore.js';
export {
  resolveToolSettings,
  toolsOverrideOf,
  ToolsOverrideSchema,
  type ToolSettings,
} from './settings.js';

/** The tools of this step, in the order they are registered. */
export const WORK_TOOL_NAMES = [
  'restricted_shell',
  'run_tests',
  'install_deps',
  'git_commit',
  'view_diff',
  'http_get',
] as const;

/** The handlers of the six work tools (architecture 5.8, N97 and N98). */
export function workToolHandlers(deps: ToolsDeps): Readonly<Record<string, ToolHandler>> {
  const context = new ToolsContext(deps);
  return {
    ...commandToolHandlers(context),
    ...gitToolHandlers(context),
    ...httpToolHandlers(context),
  };
}

/**
 * Registers the six work tools on `handlers`, skipping a name that already has a handler (a test
 * or a later step may bring its own). The tools share one semaphore of heavy commands.
 */
export function registerWorkTools(handlers: ToolHandlers, deps: ToolsDeps): ToolHandlers {
  for (const [name, handler] of Object.entries(workToolHandlers(deps))) {
    if (!handlers.has(name)) handlers.register(name, handler);
  }
  return handlers;
}
