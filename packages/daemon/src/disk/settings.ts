// SPDX-License-Identifier: MPL-2.0

/**
 * The keys of the full disk (Phase 11, P5; N279; docs/23). The schema lives in `config.ts`, which
 * reads these lists and defaults, so a mode is written once.
 *
 * - `disk.on_full` (N279, default `pause`): what the daemon does when a write finds no room or the
 *   free space goes below `disk.min_free`. `pause`: it stops opening plays and tasks, lets the turns
 *   in progress end, tells the Producer and goes back by itself when the space returns. `stop`: it
 *   tells and then stops (the same stop of a signal, reason `error`). `continue`: it only tells; the
 *   writes that fail fail, and the plays they hit are resumed when the space returns.
 * - `disk.min_free` ([proposta], default `256MB`): the free space below which the daemon counts the
 *   disk as full before a write fails; `off` waits for the write to fail. It is checked on the data
 *   directory, the logs, the backups and the worktrees.
 * - `disk.notify` ([proposta], default `once`): `once` tells at the start of the full disk and again
 *   when it ends; `every_hour` repeats the first while it lasts; `off` only logs.
 * - `disk.check_every` ([proposta], default `30s`): how often the space is read, and how often the
 *   daemon asks whether a write finds room again while it is full.
 */
export const DISK_ON_FULL_MODES = ['pause', 'stop', 'continue'] as const;
export type DiskOnFull = (typeof DISK_ON_FULL_MODES)[number];

export const DISK_NOTIFY_MODES = ['once', 'every_hour', 'off'] as const;
export type DiskNotify = (typeof DISK_NOTIFY_MODES)[number];

export const DEFAULT_DISK_MIN_FREE = '256MB';
export const DEFAULT_DISK_CHECK_EVERY = '30s';

/** The keys as the guard reads them (sizes in bytes, durations in milliseconds). */
export interface DiskSettings {
  readonly onFull: DiskOnFull;
  /** `null`: `off`, no check of the free space. */
  readonly minFreeBytes: number | null;
  readonly notify: DiskNotify;
  readonly checkEveryMs: number;
}

/** The `disk` block of the config as the guard reads it. */
export function diskSettingsOf(block: {
  readonly on_full: DiskOnFull;
  readonly min_free: number | null;
  readonly notify: DiskNotify;
  readonly check_every: number;
}): DiskSettings {
  return {
    onFull: block.on_full,
    minFreeBytes: block.min_free,
    notify: block.notify,
    checkEveryMs: block.check_every,
  };
}
