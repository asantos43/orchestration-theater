// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { describe, it } from 'vitest';
import { defaultLauncher } from './compose.js';

/**
 * True where this platform has no process launcher yet (Windows, N94 and N58): there the daemon
 * starts without the execution of attempts, and the commands answer `unavailable`.
 */
export const NO_LAUNCHER = defaultLauncher() === undefined;

/** A `describe` whose tests run a real process: skipped where there is no launcher. */
export const describeWithLauncher: ReturnType<typeof describe.skipIf> =
  describe.skipIf(NO_LAUNCHER);

/** An `it` that runs a real process: skipped where there is no launcher. */
export const itWithLauncher: ReturnType<typeof it.skipIf> = it.skipIf(NO_LAUNCHER);
