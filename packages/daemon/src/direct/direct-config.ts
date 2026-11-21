// SPDX-License-Identifier: MPL-2.0
import { DIRECT_WORKSPACES, type DirectWorkspace } from '@otheater/protocol';

/**
 * The keys of the direct session with an Actor (Phase 7, P19; N44, N190; architecture 5.20). The
 * name and the modes of `direct_session.workspace` and its default come from the architecture; the
 * other keys are [proposta].
 *
 * - `direct_session.workspace` (default `worktree`): where the Actor works. `worktree`: its own
 *   worktree and branch, and nothing reaches the integration without the Producer promoting it;
 *   `readonly`: the folder of the scenario, with a policy that only reads (a write is refused by
 *   layer 2); `scenario`: writes straight in the folder of the scenario.
 * - `direct_session.confirm_scenario` (default `ask`): `ask` makes `workspace: scenario` need the
 *   Producer's confirmation on each opening; `never` opens it at once.
 * - `direct_session.max_open` (default 3): how many sessions one scenario holds open at once.
 * - `direct_session.on_close` (default `keep`): what becomes of the branch of a `worktree` session
 *   that wrote something. `keep`: the branch stays, for the Producer to promote or delete;
 *   `discard`: it goes with the worktree.
 * - `direct_session.history_max` (default 200): how many items of the conversation the daemon
 *   keeps in memory for each session (the oldest go first; the event log keeps them all).
 * - `direct_session.closed_kept` (default 10): how many closed sessions of a scenario the daemon
 *   still lists and reads (the conversation of an older one is in the event log alone; 0: none).
 * - `direct_session.idle_timeout` (default 30m, `off` for none): a session with no turn for this
 *   long is closed (reason `idle`), so it does not hold a slot of the profile forever.
 * - `direct_session.orphans` (default `on_close`; P27, N206): what the start-up does with the
 *   worktree of a direct session that has no live session (the daemon died before closing it).
 *   `on_close`: it follows `direct_session.on_close`; `keep`: it only records it
 *   (`recovery.notice` `direct_orphan_found`); `discard`: it removes the worktree and its branch
 *   (`direct_orphan_removed`); `off`: it does not look. Only `direct-<id>` folders under
 *   `<data>/worktrees/direct` are ever touched.
 */
export { DIRECT_WORKSPACES };
export type { DirectWorkspace };

export const DIRECT_CONFIRM_MODES = ['ask', 'never'] as const;
export type DirectConfirmMode = (typeof DIRECT_CONFIRM_MODES)[number];

export const DIRECT_ON_CLOSE_MODES = ['keep', 'discard'] as const;
export type DirectOnCloseMode = (typeof DIRECT_ON_CLOSE_MODES)[number];

export const DIRECT_ORPHANS_MODES = ['on_close', 'keep', 'discard', 'off'] as const;
export type DirectOrphansMode = (typeof DIRECT_ORPHANS_MODES)[number];

/** The `direct_session` section once parsed; `idle_timeout` is milliseconds, `null` for `off`. */
export interface DirectSessionConfig {
  readonly workspace: DirectWorkspace;
  readonly confirm_scenario: DirectConfirmMode;
  readonly max_open: number;
  readonly on_close: DirectOnCloseMode;
  readonly history_max: number;
  readonly closed_kept: number;
  readonly idle_timeout: number | null;
  readonly orphans: DirectOrphansMode;
}

export const DIRECT_IDLE_TIMEOUT_DEFAULT = '30m';
