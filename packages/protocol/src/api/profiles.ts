// SPDX-License-Identifier: MPL-2.0
import { PROFILE_KINDS, PROFILE_STATES, ProfileRecordSchema } from '@otheater/core';
import { z } from 'zod';
import { PROFILE_LOGIN_MODES } from '../profile-events.js';
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

/**
 * The official login of a subscription profile, opened from an interface (P5 of Phase 7, N186;
 * architecture 5.6). [proposta] The daemon runs the client's own login in the profile directory and
 * never reads the token. The URL and the code the client prints are in the answer of the route that
 * opens the login and nowhere else: the events (`profile.login.*`) and the log carry neither, so a
 * repeat under the same `Idempotency-Key` is the only other answer that holds them. The end of the
 * login arrives as `profile.login.completed` or `profile.login.failed`.
 *
 * A login whose mode is `terminal` (OpenCode: `opencode auth login` needs a terminal) is not run by
 * the daemon: the answer is `status: local` with the command the interface runs in the terminal of
 * the person (`ot profile exec <client>/<name> login`).
 */
export const StartProfileLoginResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('started'),
    profileId: z.string().min(1),
    mode: z.enum(PROFILE_LOGIN_MODES),
    /** Where the person signs in; null when the client printed none (yet). */
    url: z.string().min(1).nullable(),
    /** The one-time code to type there (`device_code`); null when the mode has none. */
    code: z.string().min(1).nullable(),
    /** Whether `POST .../login/code` can hand the login the code the browser shows. */
    takesCode: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('local'),
    profileId: z.string().min(1),
    mode: z.literal('terminal'),
    /** What to run in a terminal, as one line. */
    command: z.string().min(1),
  }),
]);
export type StartProfileLoginResult = z.infer<typeof StartProfileLoginResultSchema>;

export const startProfileLogin = defineRoute({
  id: 'startProfileLogin',
  method: 'POST',
  path: '/v1/profiles/:client/:name/login',
  summary: 'Opens the official login of a subscription account and answers its mode, URL and code',
  params: ProfileParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: StartProfileLoginResultSchema,
  errors: ['not_found', 'conflict', 'unavailable'],
});

/** The code the browser shows at the end of a sign-in; one line. It is never logged or kept. */
export const SubmitProfileLoginCodeBodySchema = z.strictObject({
  code: z.string().min(1).max(4096),
});
export type SubmitProfileLoginCodeBody = z.input<typeof SubmitProfileLoginCodeBodySchema>;

export const SubmitProfileLoginCodeResultSchema = z.strictObject({
  profileId: z.string().min(1),
  /** The login was handed the code. Whether it accepted it arrives as `profile.login.completed` or `.failed`. */
  submitted: z.literal(true),
});
export type SubmitProfileLoginCodeResult = z.infer<typeof SubmitProfileLoginCodeResultSchema>;

export const submitProfileLoginCode = defineRoute({
  id: 'submitProfileLoginCode',
  method: 'POST',
  path: '/v1/profiles/:client/:name/login/code',
  summary: 'Hands the open login of an account the code the browser shows',
  params: ProfileParamsSchema,
  headers: IdempotencyHeadersSchema,
  body: SubmitProfileLoginCodeBodySchema,
  response: SubmitProfileLoginCodeResultSchema,
  errors: ['invalid_input', 'not_found', 'conflict', 'unavailable'],
});

export const CancelProfileLoginResultSchema = z.strictObject({
  profileId: z.string().min(1),
  /** False when no login was open (it had ended). Otherwise the process of the login was ended. */
  cancelled: z.boolean(),
});
export type CancelProfileLoginResult = z.infer<typeof CancelProfileLoginResultSchema>;

export const cancelProfileLogin = defineRoute({
  id: 'cancelProfileLogin',
  method: 'POST',
  path: '/v1/profiles/:client/:name/login/cancel',
  summary: 'Cancels the open login of an account and ends the process of the login',
  params: ProfileParamsSchema,
  headers: IdempotencyHeadersSchema,
  response: CancelProfileLoginResultSchema,
  errors: ['not_found'],
});

export const PROFILE_ROUTES = defineRoutes(
  listProfiles,
  getProfile,
  addProfile,
  drainProfile,
  removeProfile,
  startProfileLogin,
  submitProfileLoginCode,
  cancelProfileLogin,
);
