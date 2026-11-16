// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DEFAULT_TIMEOUT_MS } from './llama-cpp-server.js';

export {
  DEFAULT_TIMEOUT_MS,
  LlamaCppServer,
  type LlamaCppServerOptions,
} from './llama-cpp-server.js';
export { MAX_BODY_BYTES } from './http.js';

/**
 * Options of the adapter (`adapters.local_model_server.llama-cpp`). [proposta] the single key
 * `timeout_ms`; the strict schema makes a typo fail at start-up instead of being ignored.
 */
export const LlamaCppConfigSchema = z.strictObject({
  timeout_ms: z.int().min(1).default(DEFAULT_TIMEOUT_MS),
});

export type LlamaCppConfig = z.output<typeof LlamaCppConfigSchema>;
