// SPDX-License-Identifier: MPL-2.0
import { rm } from 'node:fs/promises';

/**
 * Removes a temp folder of a test. On Windows the folder can stay busy for a few milliseconds after
 * the last process that used it (as cwd or with an open file) is gone, so the removal retries. This
 * is tolerance for that delay only: the tests check that the processes ended before they get here.
 */
export function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
