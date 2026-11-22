// SPDX-License-Identifier: MPL-2.0
import { chmod, copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import type { InstallLayout } from './layout.js';

/**
 * The file moves of a swap (Phase 10, P8). Each is a rename or a link inside one folder tree, so it
 * is atomic, and `ot` is never absent: the old executable is first linked to `previous/` (a
 * hard link; a copy where the volume has no links), and only then does the new one replace it by
 * a rename. [proposta] This is one step more careful than "rename `ot` to `previous/ot`, then
 * `staging/ot` to `ot`" (docs/21): between those two renames there would be no executable at all.
 */

const EXECUTABLE_MODE = 0o755;

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Puts the running executable at `previous/`, replacing the one that was there. */
export async function linkPrevious(layout: InstallLayout): Promise<void> {
  await mkdir(layout.previousDir, { recursive: true });
  await rm(layout.previousExe, { force: true });
  try {
    await link(layout.exe, layout.previousExe);
  } catch {
    await copyFile(layout.exe, layout.previousExe);
    await chmod(layout.previousExe, EXECUTABLE_MODE);
  }
}

/** Makes the staged executable the executable. The old one is still at `previous/`. */
export async function placeStaged(layout: InstallLayout): Promise<void> {
  await chmod(layout.stagingExe, EXECUTABLE_MODE);
  await rename(layout.stagingExe, layout.exe);
}

/** Takes the old executable back: `previous/` replaces the executable. */
export async function restorePrevious(layout: InstallLayout): Promise<void> {
  await rename(layout.previousExe, layout.exe);
}

/** Forgets the copy at `previous/` (the swap did not get to place the new one). */
export async function undoLink(layout: InstallLayout): Promise<void> {
  await rm(layout.previousExe, { force: true });
}

/** Removes what is left of the staging folder. */
export async function clearStaging(layout: InstallLayout): Promise<void> {
  await rm(layout.stagingDir, { recursive: true, force: true });
}
