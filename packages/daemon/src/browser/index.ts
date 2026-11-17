// SPDX-License-Identifier: MPL-2.0
import type { ToolHandlers } from '../mcp/handlers.js';
import { BrowserTools, type BrowserToolsDeps } from './handlers.js';

export { WriteApprovals, isApproval, type AskApproval, type ApprovalQuestion } from './approval.js';
export { FileOrigin, type FileGrant, type IsSecretPath } from './file-origin.js';
export { makeGuard, parseOpenUrl } from './guard.js';
export { isLocalHost } from './local-host.js';
export {
  BrowserOverrideSchema,
  browserOverrideOf,
  effectiveProfile,
  resolveBrowserSettings,
  type BrowserSettings,
} from './settings.js';
export { BROWSER_TOOL_NAMES, BrowserTools, type BrowserToolsDeps } from './handlers.js';

/**
 * Registers the six browser tools on `handlers`, skipping a name that already has a handler.
 * Returns the {@link BrowserTools}: the daemon starts its idle loop and closes it when it stops.
 */
export function registerBrowserTools(handlers: ToolHandlers, deps: BrowserToolsDeps): BrowserTools {
  return new BrowserTools(deps).register(handlers);
}
