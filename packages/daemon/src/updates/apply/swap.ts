// SPDX-License-Identifier: MPL-2.0
import { chmod, copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import { crashPoint } from '../../chaos/crash-points.js';
import { retryFs, type FsRetryPolicy } from './fs-retry.js';
import type { InstallLayout } from './layout.js';

/**
 * The file moves of a swap (Phase 10, P8). Each is a rename or a link inside one folder tree, so it
 * is atomic, and `ot` is never absent: the old executable is first linked to `previous/` (a
 * hard link; a copy where the volume has no links), and only then does the new one replace it by
 * a rename. [proposta] This is one step more careful than "rename `ot` to `previous/ot`, then
 * `staging/ot` to `ot`" (docs/21): between those two renames there would be no executable at all.
 */

const EXECUTABLE_MODE = 0o755;

/**
 * The named points of the file moves where the chaos tests kill the applier (Phase 11, P6; docs/23):
 * between the calls of one step, where the journal and the disk can disagree. Free while no plan is armed.
 */
export const SWAP_CRASH_POINTS = {
  beforeLink: 'swap.before_link',
  /** The old `previous/` copy is gone and the new link is not made yet. */
  afterUnlinkPrevious: 'swap.after_unlink_previous',
  afterLink: 'swap.after_link',
  beforePlace: 'swap.before_place',
  /** The new executable is the executable and the journal still says `linked`. */
  afterPlace: 'swap.after_place',
  beforeRestore: 'swap.before_restore',
  afterRestore: 'swap.after_restore',
  beforeClearStaging: 'swap.before_clear_staging',
} as const;

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the running executable at `previous/`, replacing the one that was there. `retry` is the policy
 * of every file call below: a hold of the file that ends in a moment is not a failed step.
 */
export async function linkPrevious(layout: InstallLayout, retry?: FsRetryPolicy): Promise<void> {
  await crashPoint(SWAP_CRASH_POINTS.beforeLink);
  await mkdir(layout.previousDir, { recursive: true });
  await retryFs('rm previous', () => rm(layout.previousExe, { force: true }), retry);
  await crashPoint(SWAP_CRASH_POINTS.afterUnlinkPrevious);
  try {
    await link(layout.exe, layout.previousExe);
  } catch {
    await retryFs('copy previous', () => copyFile(layout.exe, layout.previousExe), retry);
    await chmod(layout.previousExe, EXECUTABLE_MODE);
  }
  await crashPoint(SWAP_CRASH_POINTS.afterLink);
}

/** Makes the staged executable the executable. The old one is still at `previous/`. */
export async function placeStaged(layout: InstallLayout, retry?: FsRetryPolicy): Promise<void> {
  await crashPoint(SWAP_CRASH_POINTS.beforePlace);
  await chmod(layout.stagingExe, EXECUTABLE_MODE);
  await retryFs('place staged', () => rename(layout.stagingExe, layout.exe), retry);
  await crashPoint(SWAP_CRASH_POINTS.afterPlace);
}

/** Takes the old executable back: `previous/` replaces the executable. */
export async function restorePrevious(layout: InstallLayout, retry?: FsRetryPolicy): Promise<void> {
  await crashPoint(SWAP_CRASH_POINTS.beforeRestore);
  await retryFs('restore previous', () => rename(layout.previousExe, layout.exe), retry);
  await crashPoint(SWAP_CRASH_POINTS.afterRestore);
}

/** Forgets the copy at `previous/` (the swap did not get to place the new one). */
export async function undoLink(layout: InstallLayout, retry?: FsRetryPolicy): Promise<void> {
  await retryFs('rm previous', () => rm(layout.previousExe, { force: true }), retry);
}

/** Removes what is left of the staging folder. */
export async function clearStaging(layout: InstallLayout, retry?: FsRetryPolicy): Promise<void> {
  await crashPoint(SWAP_CRASH_POINTS.beforeClearStaging);
  await retryFs('rm staging', () => rm(layout.stagingDir, { recursive: true, force: true }), retry);
}
