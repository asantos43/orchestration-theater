// SPDX-License-Identifier: MPL-2.0
import type { SetupApi } from './api.js';

/**
 * Asks the daemon whether a first run is needed (`firstRunNeeded` of `GET /v1/setup`: no first run
 * was confirmed and the configuration names no preset and no Executor). It gives up after
 * `timeoutMs` (`ui.setup.readTimeoutMs`): a daemon that does not answer must not hold the TUI, so
 * the caller treats the rejection as "do not open the assistant" and says why.
 */
export async function firstRunNeeded(api: SetupApi, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer in ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    const overview = await Promise.race([api.overview(), timeout]);
    return overview.firstRunNeeded;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
