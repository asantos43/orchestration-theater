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
 * - `telemetry_receiver_unavailable` (P2 of Phase 8, N212): the OTLP receiver could not listen
 *   (`telemetry.receiver.port` is taken, or the system refused), so the clients start without
 *   telemetry; the daemon goes on (`subject`: `receiver`; `detail`: the reason, no token) [proposta].
 * - `daemon_spans_failed` (Phase 8, P4, N214; [proposta]): the projector of the spans of the daemon
 *   could not read the log or write the base (`subject`: what failed; `detail`: why). It is told once
 *   per episode and the projector tries again; the orchestration does not depend on it.
 * - `analysis_failed` (Phase 8, P9, N55; [proposta]): the build of the daily aggregates failed for
 *   a day (`subject`: the day, `YYYY-MM-DD`, or `retention`; `detail`: why). The schedule tries the
 *   day again at the next start and at the next rollover; the raw telemetry stays where it is.
 * - `telemetry_purge_failed` (Phase 8, P8, N216; [proposta]): the purge of the raw telemetry could
 *   not run (`subject`: `purge` or `compact`; `detail`: why). The next pass tries again; the base
 *   keeps what it has.
 * - `telemetry_purge_blocked` (Phase 8, P8; [proposta]): the telemetry base is over a limit
 *   (`telemetry.retention.max_mb` or `.days`) and the purge may not remove more: the daily
 *   aggregates do not cover the oldest days yet (`subject`: `size` or `age`; `detail`: the numbers
 *   and the reason). Nothing is removed past the last day the aggregates cover.
 * - `log_rotate_failed` (Phase 8, P8; [proposta]): `daemon.log` could not be rotated (`subject`:
 *   `daemon.log`; `detail`: why). The daemon writes on to the same file and tries again later.
 * - `update_rejected` (Phase 10, P7; architecture 5.21; [proposta]): a new version was refused
 *   because it could not be trusted (`subject`: the version, or `none`; `detail`: the reason
 *   code of `daemon.update`). Nothing of it stays on disk. The same fact is the `daemon.update`
 *   event with `phase: rejected`; this notice is what reaches the global chat.
 * - `update_applied`, `update_rolled_back`, `update_failed`, `update_ask` (Phase 10, P8;
 *   [proposta]): what the global chat is told about the application of a version (`subject`: the
 *   version). `update_applied`: the new version came up and held (`detail`: the previous one).
 *   `update_rolled_back`: it did not, and the previous one is back (`detail`: the reason code of
 *   `daemon.update`). `update_failed`: it did not come up and `updates.rollback: off` left the
 *   state as it is (`detail`: the reason). `update_ask`: the `max_wait` of `idle` ended and the
 *   Producer chooses, by `POST /v1/updates/apply`, between `park` ("estaciona e aplica") and
 *   `wait` ("espera mais") (`detail`: the two options, `park|wait`).
 * - `update_no_expiry` (Phase 11, P8a; [proposta]): the manifest of the version that was acted on has
 *   no `expires` (a release made before the field existed), so it never runs out (`subject`: the
 *   version; `detail`: `updates.manifest_expiry`). With `require` it is refused instead
 *   (`update_rejected`, reason `bad_manifest`).
 * - `update_untrusted_journal` (Phase 11, P8a; [proposta]): the journal of an update, the file the
 *   applier and the daemon share, did not pass the checks (owner, permissions, a manifest signed by
 *   the embedded key that names the executable it points to), so nothing was done with it
 *   (`subject`: the version it names, or `none`; `detail`: the reason, `file`, `no_proof`,
 *   `proof_mismatch`, `bad_signature`, ...).
 * - The managed ACP adapters (Phase 10, P13; N254 revised; [proposta]); `subject` is the adapter
 *   (`claude-agent-acp`, `codex-acp`) and `detail` says the rest:
 *   - `adapter_installing`: the official client is on `PATH`, the adapter is not installed and
 *     `clients.adapters.install` is `auto`, so the download of the pinned version has started
 *     (`detail`: the version and the registry);
 *   - `adapter_installed`: the install finished (`detail`: the version and where);
 *   - `adapter_install_failed`: it did not (`detail`: the code and the reason; nothing is left
 *     half-installed);
 *   - `adapter_missing`: the client is on `PATH`, the adapter is not installed, and the mode
 *     (`ask`, `command` or `off`) does not install it by itself (`detail`: what to run);
 *   - `adapter_fallback`: `clients.<id>.adapter: managed` could not be used and the one in `PATH`
 *     runs instead (`detail`: why);
 *   - `disk_full` (Phase 11, P5, N279): a write found no room (the database, the log, a backup) or
 *     the free space went below `disk.min_free`; `subject` is the area, `detail` what the daemon
 *     does about it (`disk.on_full`: it pauses new plays, stops, or goes on). Told as `disk.notify`
 *     says; with `off` it is only logged;
 *   - `disk_recovered`: the space came back; the daemon went back to work (the plays the full disk
 *     had stopped were resumed).
 * - The code host of the deliveries (Phase 11, P13, N289; [proposta]):
 *   - `delivery_without_pr`: a delivery ended with no host to open the pull request (`adapters.code_host`
 *     is `none`, or `auto` found no GitHub remote or no credential); the work is on the local branch
 *     (`subject`: the branch; `detail`: why there is no host);
 *   - `code_host_unavailable`: `adapters.code_host: github` could not be built (`detail`: why), and
 *     the deliveries end as with `none`.
 * - `temporary_cleanup_failed` (Phase 11, N306; [proposta]): a temporary file a killed process left
 *   (`<file>.<pid>.<hex>.tmp` of `daemon-id`, `api-token` or `api.json`, or `.<addon>.<pid>.<hex>.tmp`
 *   of an extracted native addon) could not be removed (`subject`: the file name; `detail`: why). The
 *   start goes on; the file stays, and the next start tries again.
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
  'telemetry_receiver_unavailable',
  'daemon_spans_failed',
  'analysis_failed',
  'telemetry_purge_failed',
  'telemetry_purge_blocked',
  'log_rotate_failed',
  'update_rejected',
  'update_applied',
  'update_rolled_back',
  'update_failed',
  'update_ask',
  'update_no_expiry',
  'update_untrusted_journal',
  'adapter_installing',
  'adapter_installed',
  'adapter_install_failed',
  'adapter_missing',
  'adapter_fallback',
  'disk_full',
  'disk_recovered',
  'delivery_without_pr',
  'code_host_unavailable',
  'temporary_cleanup_failed',
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
 *   folder that git does not list, a branch that is not its own), so it was left alone;
 * - `orphan_left` (Phase 11, P3; [proposta]): `recovery.orphans: report` and a client process of the
 *   dead daemon is still alive, left as it is (`subject`: the client; `detail`: its session);
 * - `play_not_started` (Phase 11, P3; [proposta]): a play the dead daemon had created but not started
 *   (it was in NEED) could not be started at the restart (`subject`: the play; `detail`: why).
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
  'orphan_left',
  'play_not_started',
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
