// SPDX-License-Identifier: MPL-2.0
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { redactConfig } from './redact.js';

export function registerConfigRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  handlers.register('getConfig', () => {
    const { value, paths } = redactConfig(deps.config);
    return { config: value, redactedPaths: [...paths] };
  });
}
