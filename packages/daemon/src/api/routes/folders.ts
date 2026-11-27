// SPDX-License-Identifier: MPL-2.0
import { inspectFolder } from '../../project/inspect.js';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';

/**
 * The inspection of a folder (N332) [proposta]: what a folder is before a project is opened on it.
 * It is a POST because the path travels in the body, but it only reads: it is not a command, so it
 * does not wait for the reconciliation of the start-up and takes no `Idempotency-Key`. A path that
 * is a file is `invalid_input` through the `InvalidInput` of the core.
 */
export function registerFolderRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register(
    'inspectFolder',
    async ({ body }) => {
      const found = await inspectFolder(deps.vcs, body.path);
      return {
        path: found.path,
        state: found.state,
        git: found.git,
        initMode: deps.config.projects.init.mode,
        emptyMode: deps.config.projects.init.empty_mode,
      };
    },
    { command: false },
  );
}
