// SPDX-License-Identifier: MPL-2.0
import { rm } from 'node:fs/promises';

/**
 * Removes a temp folder of a test. On Windows the folder can stay busy for a few milliseconds after
 * the last process that used it (as cwd or with an open file) is gone, so the removal retries. This
 * is tolerance for that delay only: the tests check that the processes ended before they get here.
 * The wait grows by `retryDelay` on each try: 10 tries wait up to 5.5 s in all, and 20 tries (on
 * Windows, where a loaded runner was seen busy past 5.5 s) up to 21 s, inside the 60 s hook timeout.
 */
export function removeDir(dir: string): Promise<void> {
  const maxRetries = process.platform === 'win32' ? 20 : 10;
  return rm(dir, { recursive: true, force: true, maxRetries, retryDelay: 100 });
}
