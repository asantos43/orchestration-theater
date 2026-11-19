// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the `profile.*` events (architecture 5.6, "Perfis"; Phase 5, P2). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a strict object.
 * [proposta] The names and fields below. No payload carries a secret: an API key is never an event
 * field, only whether the profile has one and which vault backend holds it.
 */

const profileId = z.string().min(1);

/** `profile.added`: a profile was registered (its directory exists and the row is written). */
export const ProfileAddedPayloadSchema = z.strictObject({
  profileId,
  client: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['token_plan', 'api']),
  provider: z.string().min(1),
  /** True when an API key went to the vault (the key itself never leaves it). */
  hasSecret: z.boolean(),
  /** The vault backend in use (`keyring`, `encrypted-file`...), `null` when no secret was stored. */
  secretBackend: z.string().min(1).nullable(),
  /** The login probe at registration: `logged_in`, `logged_out`, `unknown`; `null` for an API profile (no login). */
  login: z.enum(['logged_in', 'logged_out', 'unknown']).nullable(),
  /** Another subscription profile of the same provider existed and the notice applied. */
  sameProviderNotice: z.boolean(),
});

/** `profile.notice_accepted`: the Producer accepted the second-subscription notice of a provider. */
export const ProfileNoticeAcceptedPayloadSchema = z.strictObject({
  profileId,
  provider: z.string().min(1),
  /** The profiles of the same provider that triggered the notice. */
  sameProvider: z.array(profileId),
  /** The value of `profiles.same_provider_notice` at the time. */
  mode: z.enum(['once', 'always']),
});

/** `profile.draining`: the profile left `active`; no new session is handed to it. */
export const ProfileDrainingPayloadSchema = z.strictObject({
  profileId,
  /** Sessions still open on the profile when the drain started. */
  activeSessions: z.int().min(0),
  /** `profiles.drain.on_timeout` at the time. */
  onTimeout: z.enum(['handoff', 'wait', 'force']),
  timeoutMs: z.int().min(0),
});

/** `profile.drained`: the drain ended (see `outcome`); the profile may now be removed. */
export const ProfileDrainedPayloadSchema = z.strictObject({
  profileId,
  /**
   * `finished`: the sessions ended by themselves; `handoff`: the ones left went back to the
   * queue; `forced`: the ones left were closed; `still_running`: `wait` kept the profile draining.
   */
  outcome: z.enum(['finished', 'handoff', 'forced', 'still_running']),
  /** Sessions that went back to the queue (`handoff`) or were closed (`forced`). */
  sessions: z.int().min(0),
});

/** `profile.removed`: the profile is `removed`; its Executors are `invalid`. */
export const ProfileRemovedPayloadSchema = z.strictObject({
  profileId,
  /** The official logout ran (false when the client had no login or the logout failed). */
  loggedOut: z.boolean(),
  /** What happened to the directory: `deleted`, `backup` (moved aside) or `missing`. */
  dir: z.enum(['deleted', 'backup', 'missing']),
  /** The secret was taken out of the vault. */
  secretDeleted: z.boolean(),
  /** Executors of the profile that became `invalid`. */
  executorsInvalidated: z.array(z.string().min(1)),
});

/**
 * What a `profile.warning` tells (Phase 5, P24, N146, [proposta]): `login_probe_failed` (the probe of
 * the login failed, so the state is `unknown`), `logout_skipped` (no adapter for the client, so no
 * official logout), `logout_failed` (the official logout failed and the removal went on),
 * `directory_undo_failed` (a profile directory a failed registration made could not be taken away),
 * `secret_missing` (a client process of an API profile starts and its key is not in the vault) and
 * `role_without_executor` (P21: a profile was removed and a role's list has no Executor left to
 * select; `detail` names the role), `exec_draining` (P28a: `ot profile exec` ran the client of a
 * profile that is draining) and `exec_refused` (P28a: `ot profile exec` did not run it; `detail` says
 * why: `removed`, `no_client` or `no_profile_cli`).
 */
export const PROFILE_WARNING_KINDS = [
  'login_probe_failed',
  'logout_skipped',
  'logout_failed',
  'directory_undo_failed',
  'secret_missing',
  'role_without_executor',
  'exec_draining',
  'exec_refused',
] as const;
export type ProfileWarningKind = (typeof PROFILE_WARNING_KINDS)[number];

/**
 * `profile.warning` (P24, N146, [proposta]): something about a profile that did not go as the
 * profile expects, and that the daemon used to only log. `detail` is masked and cut text, never the
 * key and never a path.
 */
export const ProfileWarningPayloadSchema = z.strictObject({
  profileId,
  kind: z.enum(PROFILE_WARNING_KINDS),
  detail: z.string().min(1).max(512).optional(),
});

/**
 * The command of `ot profile exec` (P28a, N159), for the events: the common command that was
 * translated (`login`, `status`, a configured one) or `native` when the arguments went to the client
 * as they were. The arguments themselves are never in an event: they may hold a prompt.
 */
const execCommand = z.string().regex(/^(native|[a-z][a-z0-9-]*)$/);

/**
 * `profile.exec.started` (P28a, N159, [proposta]): `ot profile exec` (or a command by profile, such
 * as `codex-personal`) started the official CLI of a profile in the terminal. `envInherit` is the
 * mode of `profiles.exec.env_inherit`; `apiKey` says whether the key of an API profile went in.
 */
export const ProfileExecStartedPayloadSchema = z.strictObject({
  profileId,
  command: execCommand,
  envInherit: z.enum(['terminal', 'client']),
  apiKey: z.boolean(),
});

/**
 * `profile.exec.ended` (P28a, N159, [proposta]): the CLI ended. `exitCode` is its code, or `null`
 * when a signal ended it (`signal`), or when it could not start (`startFailed`).
 */
export const ProfileExecEndedPayloadSchema = z.strictObject({
  profileId,
  command: execCommand,
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(32).nullable(),
  startFailed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
