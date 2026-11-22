// SPDX-License-Identifier: MPL-2.0
import { basename, dirname, join } from 'node:path';

/**
 * Where the files of an installation are (Phase 10, P8; architecture 5.21). [proposta]
 * - `<folder>/ot[.exe]`: the version that runs;
 * - `<folder>/previous/ot[.exe]`: the one before it (only one, so a rollback has something to go back to);
 * - `<folder>/staging/ot[.exe]`: the version that was downloaded and checked (P7), put beside the
 *   executable so that the swap is a rename inside one volume;
 * - `<folder>/update-state.json`: the journal of the swap, one step at a time.
 */
export interface InstallLayout {
  readonly folder: string;
  /** The running executable. */
  readonly exe: string;
  readonly previousDir: string;
  readonly previousExe: string;
  readonly stagingDir: string;
  readonly stagingExe: string;
  readonly journal: string;
}

/** The layout of the installation whose executable is `exe` (an absolute path). */
export function layoutOf(exe: string): InstallLayout {
  const folder = dirname(exe);
  const name = basename(exe);
  const previousDir = join(folder, 'previous');
  const stagingDir = join(folder, 'staging');
  return {
    folder,
    exe,
    previousDir,
    previousExe: join(previousDir, name),
    stagingDir,
    stagingExe: join(stagingDir, name),
    journal: join(folder, 'update-state.json'),
  };
}
