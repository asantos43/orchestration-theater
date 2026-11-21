// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the `daemon.notice`, `recovery.notice` and `scenario.notice` events (Phase 5, P24,
 * N146 and N149). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every
 * payload is a strict object. The owner's order of 2026-11-18: a situation the daemon only wrote to
 * the log is also an event, so hooks and plugins can extend the platform; the log line stays.
 * [proposta] The names, the kinds and the fields below.
 *
 * Text rule: `subject` and `detail` are short texts in English (`detail` is masked and cut by the
 * daemon with `eventErrorText`), never a credential, a token or a path of the secret list.
 */

const subject = z.string().min(1).max(256).nullable();
const detail = z.string().min(1).max(512).nullable();

/**
 * What a `daemon.notice` tells: the state of the daemon itself at start-up or while it runs.
 * - `vault_locked`: the vault stays locked (no prompt, or no master password given);
 * - `vault_wrong_password`: a wrong master password (`detail` says which try);
 * - `backup_unsupported`: the store cannot make copies, so the scheduled backups are off;
 * - `deprecated_config`: a configuration key that still works and has a new place;
 * - `execution_off`: the execution of attempts is off (`subject`: `no_launcher` or `no_client`);
 * - `sandbox_unavailable`: layer 3 is not there, so `writeScope` and `network` have no guarantee;
 * - `sandbox_nested`: `clients.codex.inner_sandbox: nested` weakens the write denies of the sandbox;
 * - `client_not_found`: a client is enabled by force and its executable is not in `PATH`
 *   (`subject`: the client id);
 * - `client_warning`: the adapter of a client warned (`subject`: the client id; `detail`: the kind of
 *   the warning of N69 and its text);
 * - `browser_warning`: the browser adapter warned;
 * - `cross_check_unsatisfiable` (P15b, N150): with `selection.cross_check` strict, the list of the
 *   Reviewer or of the Critic (`subject`: the role) has Executors of one provider only (or, with
 *   `other_model`, of one model), so the cross-review cannot be met and falls to the provider of
 *   the work (`detail` says which mode and what the fall takes);
 * - `account_rotated` (P26, N157): `profiles.rotate_on_exhaustion.<provider>` is `on` and a
 *   subscription account of that provider ran out, so the work passed to another account of the
 *   same provider (`subject`: the role; `detail`: the provider, the profile that ran out and the
 *   profile that took the work; the envelope carries the play and the attempt) [proposta];
 * - `daemon_spans_failed` (Phase 8, P4, N214; [proposta]): the projector of the spans of the daemon
 *   could not read the log or write the base (`subject`: what failed; `detail`: why). It is told once
 *   per episode and the projector tries again; the orchestration does not depend on it.
 */
export const DAEMON_NOTICE_KINDS = [
  'vault_locked',
  'vault_wrong_password',
  'backup_unsupported',
  'deprecated_config',
  'execution_off',
  'sandbox_unavailable',
  'sandbox_nested',
  'client_not_found',
  'client_warning',
  'browser_warning',
  'cross_check_unsatisfiable',
  'account_rotated',
  'daemon_spans_failed',
] as const;
export type DaemonNoticeKind = (typeof DAEMON_NOTICE_KINDS)[number];

/**
 * `daemon.notice`: a situation of the daemon (not of a play or a profile) that it used to only log.
 * One written before `daemon.started` waits for it, so the log reads in the order it happened.
 */
export const DaemonNoticePayloadSchema = z.strictObject({
  kind: z.enum(DAEMON_NOTICE_KINDS),
  subject,
  detail,
});

/**
 * What a `recovery.notice` tells: backup and recovery (architecture 5.21) that went worse than
 * planned, and that no other event says.
 * - `backup_rotation_failed`: the new copy is good, but the rotation of the old ones failed;
 * - `backup_telemetry_failed` (P1 of Phase 8): `backup.telemetry: include` and the copy of the telemetry
 *   file failed; the copy of the store is good and carries no telemetry;
 * - `retention_remove_failed`: retention could not remove an old copy (`subject`: its folder name);
 * - `process_not_tracked`: a process a client started is not written down, so the next daemon cannot
 *   find it as an orphan;
 * - `effect_unsettled`: an effect with an intent and no end could not be settled by its verifier, so
 *   the Producer is asked (the play is the `playId` of the envelope);
 * - `direct_orphan_found` (P27, N206; [proposta]): at start-up, the worktree of a direct session
 *   with no live session was found and `direct_session.orphans` leaves it (`subject`: its branch;
 *   `detail`: where it is, under the data folder);
 * - `direct_orphan_removed` (P27): the same worktree was removed, with its branch;
 * - `direct_orphan_failed` (P27): it could not be removed, or it was not safe to remove (a link, a
 *   folder that git does not list, a branch that is not its own), so it was left alone.
 * A failed backup is `daemon.backup` with `ok: false`, and the counts of a recovery are
 * `daemon.recovered`: neither is repeated here.
 */
export const RECOVERY_NOTICE_KINDS = [
  'backup_rotation_failed',
  'backup_telemetry_failed',
  'retention_remove_failed',
  'process_not_tracked',
  'effect_unsettled',
  'direct_orphan_found',
  'direct_orphan_removed',
  'direct_orphan_failed',
] as const;
export type RecoveryNoticeKind = (typeof RECOVERY_NOTICE_KINDS)[number];

/** `recovery.notice`: see {@link RECOVERY_NOTICE_KINDS}. The envelope carries `playId` when there is one. */
export const RecoveryNoticePayloadSchema = z.strictObject({
  kind: z.enum(RECOVERY_NOTICE_KINDS),
  subject,
  detail,
});

/**
 * What a `scenario.notice` tells: a situation of a scenario the daemon used to only log.
 * - `ideas_setting_ignored`: a key `ideas.*` of the override of the scenario is not used (`subject`: the problem);
 * - `idea_not_returned`: an idea of a group lost in a restart could not be given back (`subject`: the idea);
 * - `consult_worktree_stayed`: the worktree of a consultant could not be removed;
 * - `consult_files_refused`: the files of a consultant were not merged (`subject`: the branch; `detail`: why);
 * - `conventions_not_confirmed`: the confirmation of the conventions of the project failed;
 * - `direct_worktree_stayed`: the worktree of a direct session could not be removed (P19; `subject`: the branch).
 */
export const SCENARIO_NOTICE_KINDS = [
  'ideas_setting_ignored',
  'idea_not_returned',
  'consult_worktree_stayed',
  'consult_files_refused',
  'conventions_not_confirmed',
  'direct_worktree_stayed',
] as const;
export type ScenarioNoticeKind = (typeof SCENARIO_NOTICE_KINDS)[number];

/** `scenario.notice`: see {@link SCENARIO_NOTICE_KINDS}. */
export const ScenarioNoticePayloadSchema = z.strictObject({
  scenarioId: z.string().min(1),
  kind: z.enum(SCENARIO_NOTICE_KINDS),
  subject,
  detail,
});
