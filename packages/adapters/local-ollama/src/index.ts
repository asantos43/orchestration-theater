// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { z } from 'zod';
import {
  CONTEXT_MODES,
  CONTEXT_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  HEALTH_PROBES,
  MODELS_SOURCES,
  OllamaServer,
} from './ollama-server.js';
import { endpointUrl } from './http.js';

export {
  CONTEXT_MODES,
  CONTEXT_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  HEALTH_PROBES,
  MODELS_SOURCES,
  OllamaServer,
  type ContextMode,
  type ContextWindowMode,
  type HealthProbe,
  type ModelsSource,
  type OllamaServerOptions,
  type ParallelResolver,
} from './ollama-server.js';
export { MAX_BODY_BYTES } from './http.js';

/**
 * Options of the adapter (`adapters.local_model_server.ollama`). Every default is a key with
 * several modes [proposta]; the strict schema makes a typo fail at start-up instead of being
 * ignored.
 *
 * - `timeout_ms`: wait for each HTTP call.
 * - `health_probe`: `version` (`GET /api/version`), `root` (`GET /`) or `tags` (`GET /api/tags`).
 * - `models_source`: `installed` (`/api/tags`) or `loaded` (`/api/ps`).
 * - `context_window`: `loaded` fills `contextWindow` from `/api/ps`; `none` leaves it out.
 * - `context_mode`: `total` (`context_length` is divided by `parallel`) or `per_slot`.
 * - `parallel`: `OLLAMA_NUM_PARALLEL` of every instance, the server does not say it [N]. Absent:
 *   unknown, and `slots: auto` falls back to 1 and the setup assistant asks (architecture 5.9).
 * - `parallel_by_url`: the same per instance, by base URL; wins over `parallel`.
 */
export const OllamaConfigSchema = z.strictObject({
  timeout_ms: z.int().min(1).default(DEFAULT_TIMEOUT_MS),
  health_probe: z.enum(HEALTH_PROBES).default('version'),
  models_source: z.enum(MODELS_SOURCES).default('installed'),
  context_window: z.enum(CONTEXT_WINDOWS).default('loaded'),
  context_mode: z.enum(CONTEXT_MODES).default('total'),
  parallel: z.int().min(1).optional(),
  parallel_by_url: z.record(z.url({ protocol: /^https?$/ }), z.int().min(1)).default({}),
});

export type OllamaConfig = z.output<typeof OllamaConfigSchema>;

/**
 * Builds the adapter from its parsed configuration. `parallel_by_url` keys are compared as base
 * URLs (a trailing slash and a query do not matter).
 *
 * @throws InvalidInput when a `parallel_by_url` key is not a usable URL.
 */
export function createOllamaServer(config: OllamaConfig): OllamaServer {
  const byUrl = new Map(
    Object.entries(config.parallel_by_url).map(([url, count]) => [
      endpointUrl(url, '').href,
      count,
    ]),
  );
  return new OllamaServer({
    timeoutMs: config.timeout_ms,
    healthProbe: config.health_probe,
    modelsSource: config.models_source,
    contextWindow: config.context_window,
    contextMode: config.context_mode,
    parallel: (url) => {
      try {
        return byUrl.get(endpointUrl(url, '').href) ?? config.parallel;
      } catch (error) {
        if (error instanceof InvalidInput) return config.parallel;
        throw error;
      }
    },
  });
}
