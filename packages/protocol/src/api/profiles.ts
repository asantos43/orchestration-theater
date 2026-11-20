// SPDX-License-Identifier: MPL-2.0
import { PROFILE_KINDS, PROFILE_STATES, ProfileRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { QUOTA_CAUSES, QUOTA_STATES } from '../quota-events.js';
import { IdempotencyHeadersSchema, PageQuerySchema, pageOf } from './page.js';
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

const ProfileParamsSchema = z.strictObject({
  client: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
});

/**
 * Registers an account (P6 of docs/17; `ot profile add` without the login, which is interactive and
 * stays at the terminal). [proposta] An `api` profile brings its `apiKey`, which goes straight to
 * the vault: no response, event or log carries it, and a repeat under the same `Idempotency-Key` is
 * recognized by a keyed digest of the body, never by the body. A second subscription of one
 * provider answers `status: needs_notice` (HTTP 200) with the notice; the client shows it and sends
 * the same body again with `acceptNotice: true`.
 */
export const AddProfileBodySchema = z.strictObject({
  client: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  kind: z.enum(PROFILE_KINDS),
  provider: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(8192).optional(),
  acceptNotice: z.boolean().optional(),
});
export type AddProfileBody = z.input<typeof AddProfileBodySchema>;

/** The notice of a second subscription of the same provider (architecture N127). */
export const ProfileNoticeSchema = z.strictObject({
  provider: z.string().min(1),
  existing: z.array(z.string().min(1)),
  mode: z.enum(['once', 'always']),
});
export type ProfileNotice = z.infer<typeof ProfileNoticeSchema>;

export const AddProfileResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('added'),
    profile: ProfileRecordSchema,
    hasSecret: z.boolean(),
    /** The vault that keeps the key (`keyring`, `file`...), or null for a subscription. */
    secretBackend: z.string().nullable(),
    /** Whether the client has a login in the profile; null for an `api` profile. */
    login: z.enum(['logged_in', 'logged_out', 'unknown']).nullable(),
    notice: ProfileNoticeSchema.nullable(),
  }),
  z.strictObject({ status: z.literal('needs_notice'), notice: ProfileNoticeSchema }),
]);
export type AddProfileResult = z.infer<typeof AddProfileResultSchema>;

export const addProfile = defineRoute({
  id: 'addProfile',
  method: 'POST',
  path: '/v1/profiles',
  summary: 'Registers an account (a subscription profile or an API key profile); idempotent',
  headers: IdempotencyHeadersSchema,
  body: AddProfileBodySchema,
  response: AddProfileResultSchema,
  errors: ['conflict', 'vault_locked'],
});

/** What a drain or a removal waits for the running sessions: `profiles.drain.timeout` unless given. */
export const ProfileTimeoutSchema = z.strictObject({ timeoutMs: z.int().min(0).optional() });

export const DrainProfileResultSchema = z.strictObject({
  profile: ProfileRecordSchema,
  outcome: z.enum(['finished', 'handoff', 'forced', 'still_running']),
  /** Sessions handed back to the queue or closed. */
  sessions: z.int().min(0),
});
export type DrainProfileResult = z.infer<typeof DrainProfileResultSchema>;

export const drainProfile = defineRoute({
  id: 'drainProfile',
  method: 'POST',
  path: '/v1/profiles/:client/:name/drain',
  summary: 'Stops giving new sessions to an account and waits for the running ones',
  params: ProfileParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: ProfileTimeoutSchema.optional(),
  response: DrainProfileResultSchema,
  errors: ['not_found', 'conflict'],
});

export const RemoveProfileResultSchema = z.strictObject({
  profile: ProfileRecordSchema,
  drain: DrainProfileResultSchema.nullable(),
  loggedOut: z.boolean(),
  dir: z.enum(['deleted', 'backup', 'missing']),
  secretDeleted: z.boolean(),
  /** The Executors that stopped being valid with the account. */
  executorsInvalidated: z.array(z.string()),
});
export type RemoveProfileResult = z.infer<typeof RemoveProfileResultSchema>;

export const removeProfile = defineRoute({
  id: 'removeProfile',
  method: 'DELETE',
  path: '/v1/profiles/:client/:name',
  summary: 'Drains and removes an account: its directory, its secret and its Executors',
  params: ProfileParamsSchema,
  query: z.strictObject({ timeoutMs: z.coerce.number().int().min(0).optional() }),
  headers: IdempotencyHeadersSchema,
  response: RemoveProfileResultSchema,
  errors: ['not_found', 'conflict'],
});

export const PROFILE_ROUTES = defineRoutes(
  listProfiles,
  getProfile,
  addProfile,
  drainProfile,
  removeProfile,
);
