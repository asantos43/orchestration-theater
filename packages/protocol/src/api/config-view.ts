// SPDX-License-Identifier: MPL-2.0
import { JsonObjectSchema } from '@otheater/core';
import { z } from 'zod';
import { CONFIG_APPLIES_ON } from '../api-command-events.js';
import { IdempotencyHeadersSchema } from './page.js';
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

/**
 * Edits the configuration file (`config.yaml`; P6 of docs/17). [proposta] The edit is the one of
 * `config-edit.ts`: the comments and the order of the file stay, the result is validated like a
 * start would validate it (an edit that leaves a config the daemon would refuse is `invalid_input`,
 * naming the key) and written atomically. A value that could be a secret (see `getConfig`) is
 * refused: a secret goes to the vault, never to the YAML. The running daemon keeps the configuration
 * it started with, so the answer says the edit applies on restart.
 */
export const ConfigKeyPathSchema = z.array(z.string().min(1).max(256)).min(1).max(16);

export const ConfigEditBodySchema = z
  .strictObject({
    /** Keys to set (created as needed), each as its path and a plain JSON value. */
    set: z
      .array(z.strictObject({ path: ConfigKeyPathSchema, value: z.json() }))
      .max(64)
      .optional(),
    /** Keys to take out; the file goes back to the default of each. */
    remove: z.array(ConfigKeyPathSchema).max(64).optional(),
  })
  .refine((edit) => (edit.set?.length ?? 0) + (edit.remove?.length ?? 0) > 0, {
    message: 'Give at least one key to set or to remove',
  });
export type ConfigEditBody = z.input<typeof ConfigEditBodySchema>;

export const ConfigEditResultSchema = z.strictObject({
  /**
   * When the edit takes effect (N188): `hot` when every key was taken in at once, `restart` when
   * none was, `mixed` when `hot` and `restart` both list keys.
   */
  appliesOn: z.enum(CONFIG_APPLIES_ON),
  /** The dotted paths that were set and the ones taken out (never the values). */
  set: z.array(z.string()),
  removed: z.array(z.string()),
  /** The edited paths that changed behaviour without a restart (`ui.*`, `chat.*`, `limits.*`, `roles.*`). */
  hot: z.array(z.string()),
  /** The edited paths the daemon only reads at its next start. */
  restart: z.array(z.string()),
});
export type ConfigEditResult = z.infer<typeof ConfigEditResultSchema>;

export const putConfig = defineRoute({
  id: 'putConfig',
  method: 'PUT',
  path: '/v1/config',
  summary:
    'Edits keys of the configuration file with the validation of a start; ui, chat, limits and roles apply at once, the rest on restart',
  headers: IdempotencyHeadersSchema,
  body: ConfigEditBodySchema,
  response: ConfigEditResultSchema,
  errors: ['conflict'],
});

export const CONFIG_VIEW_ROUTES = defineRoutes(getConfig, putConfig);
