// SPDX-License-Identifier: MPL-2.0
import { JsonObjectSchema } from '@otheater/core';
import { z } from 'zod';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The effective configuration (what the daemon runs with, defaults included) for a client to read
 * (P5 of docs/17). [proposta] It carries no secret at all: a literal that could be one is replaced
 * by {@link REDACTED_VALUE} and its path is listed in `redactedPaths`, so a screen can say so. The
 * daemon decides what could be a secret by the name of the key and by the shape of the value (see
 * `redactConfig` in the daemon); a key that only names an environment variable (`api_key_env`)
 * is not a secret and comes as it is.
 */

/** What takes the place of a value that was held back. */
export const REDACTED_VALUE = '[redacted]';

export const ApiConfigSchema = z.strictObject({
  config: JsonObjectSchema,
  /** The paths (`clients.codex.env.TOKEN`) whose value was replaced by {@link REDACTED_VALUE}. */
  redactedPaths: z.array(z.string()),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const getConfig = defineRoute({
  id: 'getConfig',
  method: 'GET',
  path: '/v1/config',
  summary: 'The effective configuration, with every value that could be a secret held back',
  response: ApiConfigSchema,
});

export const CONFIG_VIEW_ROUTES = defineRoutes(getConfig);
