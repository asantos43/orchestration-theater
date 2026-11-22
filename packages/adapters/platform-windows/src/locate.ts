// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_LAUNCHER_FILE } from './config.js';

/** Where to look for `ot-job-launcher.exe`, and how to tell that a file is there. */
export interface LocateOptions {
  /** Absolute path chosen by the user or the installer (`processes.windows_launcher_path`). */
  readonly configuredPath?: string | null;
  /** The executable of the running program: the launcher sits beside it once installed (P4). */
  readonly execPath: string;
  /** Roots of a checkout (the folder that holds `native/`), searched in `target/release` then `target/debug`. */
  readonly checkoutRoots?: readonly string[];
  /** Replaceable by a test; the default is the file system. */
  readonly exists?: (path: string) => boolean;
}

/** What {@link locateJobLauncher} found, and where it looked when it found nothing. */
export type LocateResult =
  | { readonly found: true; readonly path: string }
  | { readonly found: false; readonly searched: readonly string[] };

/**
 * Finds `ot-job-launcher.exe` (Phase 10, P2). Order: the configured path (only that one, when it
 * is set: a path the user wrote that is wrong is an error, not a reason to use another copy), the
 * folder of the running executable, then a checkout's `native/job-launcher/target/release` and
 * `target/debug` [N: the paths of `cargo build` are the default of cargo, checked on the manifest
 * of the crate, which has no `[workspace]` and no `target-dir`]. Paths use Windows rules whatever
 * the platform, so the lookup can be tested anywhere.
 */
export function locateJobLauncher(options: LocateOptions): LocateResult {
  const exists = options.exists ?? existsSync;
  const candidates: string[] = [];
  if (options.configuredPath !== undefined && options.configuredPath !== null) {
    candidates.push(options.configuredPath);
  } else {
    candidates.push(win32.join(win32.dirname(options.execPath), JOB_LAUNCHER_FILE));
    for (const root of options.checkoutRoots ?? []) {
      for (const profile of ['release', 'debug']) {
        candidates.push(
          win32.join(root, 'native', 'job-launcher', 'target', profile, JOB_LAUNCHER_FILE),
        );
      }
    }
  }
  const path = candidates.find((candidate) => win32.isAbsolute(candidate) && exists(candidate));
  return path === undefined ? { found: false, searched: candidates } : { found: true, path };
}

/**
 * The checkout this module runs from, when it is in one: the nearest parent that has
 * `native/job-launcher/Cargo.toml`. Empty inside a single executable (the module has no file) and
 * in an installed copy, where the launcher is beside the executable.
 */
export function checkoutRoots(moduleUrl: string = import.meta.url): readonly string[] {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(moduleUrl));
  } catch {
    return [];
  }
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'native', 'job-launcher', 'Cargo.toml'))) return [dir];
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}
