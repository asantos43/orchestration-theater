// SPDX-License-Identifier: MPL-2.0
import { PROFILE_KINDS, PROFILE_STATES, ProfileRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { QUOTA_CAUSES, QUOTA_STATES } from '../quota-events.js';
import { PageQuerySchema, pageOf } from './page.js';
import { defineRoute, defineRoutes } from './route.js';

/**
 * The accounts (profiles) and the quota state of each (P5 of docs/17). [proposta] The record is the
 * store's, whose `secretRef` is a reference into the vault and never the secret; `hasSecret` is the
 * flag a screen needs.
 */

/** The state of the quota of a profile, as the daemon's quota service holds it. */
export const ApiQuotaWindowSchema = z.strictObject({
  window: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: z.int().min(0).nullable(),
  observedAt: z.int().min(0),
  source: z.string().min(1),
  /** Recent enough and not past its reset: only a fresh reading can authorize a new session. */
  fresh: z.boolean(),
});
export type ApiQuotaWindow = z.infer<typeof ApiQuotaWindowSchema>;

export const ApiQuotaStatusSchema = z.strictObject({
  profile: z.string().min(1),
  state: z.enum(QUOTA_STATES),
  /** Why it is exhausted; null in any other state. */
  cause: z.enum(QUOTA_CAUSES).nullable(),
  /** Until when it is exhausted (epoch ms); null when no source says. */
  untilReset: z.int().min(0).nullable(),
  windows: z.array(ApiQuotaWindowSchema),
  observedAt: z.int().min(0).nullable(),
  nearLimitWindow: ApiQuotaWindowSchema.nullable(),
  reason: z.string(),
  /** Whether a new session may start on it now (`ok` or `near_limit`). */
  authorizes: z.boolean(),
});
export type ApiQuotaStatus = z.infer<typeof ApiQuotaStatusSchema>;

export const ApiProfileSchema = z.strictObject({
  profile: ProfileRecordSchema,
  hasSecret: z.boolean(),
  executors: z.strictObject({ valid: z.int().min(0), invalid: z.int().min(0) }),
  /** Null while the quota service has not read the profile (a removed one, say). */
  quota: ApiQuotaStatusSchema.nullable(),
});
export type ApiProfile = z.infer<typeof ApiProfileSchema>;

export const ListProfilesQuerySchema = PageQuerySchema.extend({
  client: z.string().min(1).max(64).optional(),
  kind: z.enum(PROFILE_KINDS).optional(),
  state: z.enum(PROFILE_STATES).optional(),
});
export type ListProfilesQuery = z.input<typeof ListProfilesQuerySchema>;

export const listProfiles = defineRoute({
  id: 'listProfiles',
  method: 'GET',
  path: '/v1/profiles',
  summary: 'Accounts with the state of the quota of each, in the order they were made, by cursor',
  query: ListProfilesQuerySchema,
  response: pageOf(ApiProfileSchema),
});

export const getProfile = defineRoute({
  id: 'getProfile',
  method: 'GET',
  path: '/v1/profiles/:client/:name',
  summary: 'One account with its quota state',
  params: z.strictObject({ client: z.string().min(1).max(64), name: z.string().min(1).max(128) }),
  response: ApiProfileSchema,
  errors: ['not_found'],
});

export const PROFILE_ROUTES = defineRoutes(listProfiles, getProfile);
