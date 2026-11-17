// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '@otheater/core';

/** What the admission of a new Chromium looks at (architecture 5.9: RAM admission). */
export interface AdmissionInput {
  /** Browsers running or starting. */
  readonly running: number;
  readonly maxInstances: number;
  readonly freeMemoryBytes: number;
  readonly minFreeMemoryBytes: number;
}

const MIB = 1024 * 1024;

/**
 * Admits one more Chromium, or rejects with `AdapterUnavailable` and says why. [proposta] Two
 * checks, both configuration keys (`browser.max_instances`, `browser.min_free_memory_mb`): a browser
 * of a scenario never starts when the machine is short of RAM, and never past the number of browsers
 * the owner allows. The caller tries again later; nothing is queued here.
 */
export function admitBrowser(input: AdmissionInput): void {
  if (input.running >= input.maxInstances) {
    throw new AdapterUnavailable(
      `Browser not started: ${String(input.running)} of ${String(input.maxInstances)} browsers are already running (browser.max_instances). Close a page or try again later.`,
    );
  }
  if (input.freeMemoryBytes < input.minFreeMemoryBytes) {
    throw new AdapterUnavailable(
      `Browser not started: ${String(Math.floor(input.freeMemoryBytes / MIB))} MiB of RAM are free and browser.min_free_memory_mb asks for ${String(Math.ceil(input.minFreeMemoryBytes / MIB))} MiB. Try again when the machine has more memory.`,
    );
  }
}
