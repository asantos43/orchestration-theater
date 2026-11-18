// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { PROFILE_NAME_PATTERN } from './executor.js';
import { EpochMsSchema } from './store-schemas.js';

/**
 * The `profiles` table (architecture section 7, 5.6): one row per client account. Carries no
 * secret: `secretRef` only names where the `SecretVault` keeps it. [proposta] The columns below.
 */

/** `token_plan` is a subscription; `api` is a key billed by use. */
export const PROFILE_KINDS = ['token_plan', 'api'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** Lifecycle of a profile (5.6): `draining` takes no new session; `removed` is final. */
export const PROFILE_STATES = ['active', 'draining', 'removed'] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

/** The states a profile can go to from each state (`draining` back to `active` cancels a drain). */
export const PROFILE_TRANSITIONS: Readonly<Record<ProfileState, readonly ProfileState[]>> = {
  active: ['draining'],
  draining: ['active', 'removed'],
  removed: [],
};

const text = z.string().min(1);
const name = z.string().regex(PROFILE_NAME_PATTERN);

/** One row of `profiles`. */
export const ProfileRecordSchema = z.strictObject({
  /** `<client>/<name>`, the id used in configuration keys and event payloads. */
  id: text,
  /** Client id (`claude-code`, `codex`, `opencode`...). */
  client: name,
  /** Profile name, unique within the client. */
  name,
  kind: z.enum(PROFILE_KINDS),
  /** Provider of the account (`anthropic`, `openai`...): two subscriptions of one provider raise the notice. */
  provider: text,
  state: z.enum(PROFILE_STATES),
  /** The isolated directory of the profile (what `profileDirOf` computes). */
  dir: text,
  /** Where the vault keeps the secret of an `api` profile; null for a subscription. */
  secretRef: text.nullable(),
  /** When the Producer accepted the notice of a second subscription of the same provider. */
  noticeAcceptedAt: EpochMsSchema.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** Set when the profile reached `removed`. */
  removedAt: EpochMsSchema.nullable(),
});
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;

/** What a caller writes; the store assigns `id`, the state (`active`) and the dates. */
export const NewProfileSchema = ProfileRecordSchema.pick({
  client: true,
  name: true,
  kind: true,
  provider: true,
  dir: true,
  secretRef: true,
}).partial({ secretRef: true });
export type NewProfile = z.infer<typeof NewProfileSchema>;

/** Fields `update` may change; a state change must follow {@link PROFILE_TRANSITIONS}. */
export const ProfilePatchSchema = z.strictObject({
  state: z.enum(PROFILE_STATES).optional(),
  provider: text.optional(),
  dir: text.optional(),
  secretRef: text.nullable().optional(),
  noticeAcceptedAt: EpochMsSchema.nullable().optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export interface ProfileListFilter {
  readonly client?: string;
  readonly kind?: ProfileKind;
  readonly provider?: string;
  /** Only profiles in one of these states. Omitted means all. */
  readonly states?: readonly ProfileState[];
}

/**
 * Registry of profiles, part of `Store`. Contract (`describeProfileConformance`):
 * - `create` validates (`InvalidInput`), assigns the id `<client>/<name>` and stores the profile
 *   `active`; `Conflict` when the id exists, even for a `removed` profile (a name is not reused).
 * - `get` and `list`; `list` is ordered by creation, then id.
 * - `update(id, patch)` changes the fields of {@link ProfilePatchSchema}: `NotFound` for an
 *   unknown id, `InvalidInput` for a bad patch, `Conflict` for a state change that is not in
 *   {@link PROFILE_TRANSITIONS} (the same state is accepted and changes nothing). Reaching
 *   `removed` stamps `removedAt`. Fields left out keep their value.
 */
export interface ProfileRegistry {
  create(input: NewProfile): Promise<ProfileRecord>;
  get(id: string): Promise<ProfileRecord | undefined>;
  list(filter?: ProfileListFilter): Promise<readonly ProfileRecord[]>;
  update(id: string, patch: ProfilePatch): Promise<ProfileRecord>;
}
