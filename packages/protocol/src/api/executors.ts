// SPDX-License-Identifier: MPL-2.0
import {
  CAPABILITY_CHECK_MODES,
  NOTE_CODES,
  ROLE_IDS,
  ROLE_PRESET_NAMES,
  WHEN_EXHAUSTED_MODES,
} from '@otheater/core';
import { z } from 'zod';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The Executors (model + effort + account) and the lists of the roles (P5 of docs/17). [proposta]
 * `GET /v1/roles` answers the ordered list of each role and what the selection would do now: the
 * `next` Executor (the first valid one with quota and money) and the rule `whenExhausted` (`next`:
 * go on down the list; `wait`: hold the demand until one is free).
 */

export const ApiExecutorSchema = z.strictObject({
  id: z.string().min(1),
  profileId: z.string().min(1),
  client: z.string().min(1),
  profile: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  provider: z.string().min(1),
  validity: z.enum(['valid', 'invalid']),
  invalidReason: z.string().nullable(),
  /** Written in `executors.<id>` of the configuration. */
  configured: z.boolean(),
  /** The roles whose list holds it now. */
  roles: z.array(z.enum(ROLE_IDS)),
});
export type ApiExecutor = z.infer<typeof ApiExecutorSchema>;

export const ListExecutorsQuerySchema = PageQuerySchema.extend({
  profileId: z.string().min(1).max(256).optional(),
  validity: z.enum(['valid', 'invalid']).optional(),
});
export type ListExecutorsQuery = z.input<typeof ListExecutorsQuerySchema>;

export const listExecutors = defineRoute({
  id: 'listExecutors',
  method: 'GET',
  path: '/v1/executors',
  summary: 'Executors of the configuration and of the table, by id, by cursor',
  query: ListExecutorsQuerySchema,
  response: pageOf(ApiExecutorSchema),
});

/** Why an Executor of a role list would not take the next demand now. */
export const EXECUTOR_BLOCKS = ['invalid', 'quota', 'budget'] as const;

export const ApiRoleExecutorSchema = z.strictObject({
  id: z.string().min(1),
  profileId: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  provider: z.string().min(1),
  validity: z.enum(['valid', 'invalid']),
  invalidReason: z.string().nullable(),
  /** Where the item of the list came from. */
  origin: z.enum(['preset', 'api_fallback', 'config', 'legacy']),
  /** Null when it could take a demand now. */
  blockedBy: z.enum(EXECUTOR_BLOCKS).nullable(),
  /** What the role asks and the Executor lacks (`context`, `reasoning`). */
  shortfalls: z.array(z.enum(['context', 'reasoning'])),
});
export type ApiRoleExecutor = z.infer<typeof ApiRoleExecutorSchema>;

export const ApiRoleSchema = z.strictObject({
  role: z.enum(ROLE_IDS),
  /** `preset`: expanded; `config`: a list somebody wrote; `legacy`: the old fixed Executor. */
  source: z.enum(['preset', 'config', 'legacy']),
  whenExhausted: z.enum(WHEN_EXHAUSTED_MODES),
  /** The list, in the order the selection tries it. */
  executors: z.array(ApiRoleExecutorSchema),
  /** The first Executor of the list that could take a demand now; null when none can. */
  next: z.string().min(1).nullable(),
});
export type ApiRole = z.infer<typeof ApiRoleSchema>;

export const ApiRolesSchema = z.strictObject({
  preset: z.enum(ROLE_PRESET_NAMES),
  capabilityCheck: z.enum(CAPABILITY_CHECK_MODES),
  /** `roles.allowed_profiles` in force; null: every account. */
  allowedProfiles: z.array(z.string().min(1)).nullable(),
  roles: z.array(ApiRoleSchema),
  notes: z.array(
    z.strictObject({
      severity: z.enum(['info', 'warning']),
      code: z.enum(NOTE_CODES),
      role: z.enum(ROLE_IDS),
      executorId: z.string().nullable(),
      /** The `<model>-<effort>` of the preset a `no_account` note is about (N324). */
      head: z.string().optional(),
      message: z.string(),
    }),
  ),
});
export type ApiRoles = z.infer<typeof ApiRolesSchema>;

export const listRoles = defineRoute({
  id: 'listRoles',
  method: 'GET',
  path: '/v1/roles',
  summary: 'The ordered Executor list of each role, with the next Executor and the exhaustion rule',
  response: ApiRolesSchema,
});

export const EXECUTOR_ROUTES = defineRoutes(listExecutors, listRoles);
