// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapterWarning } from '@otheater/core';
import type { CATALOG_PROBE_LOG_MODES } from './config.js';
import type { Logger } from './logger.js';

export type CatalogProbeLogMode = (typeof CATALOG_PROBE_LOG_MODES)[number];

/** Takes what an adapter warns of and writes it to the daemon log. */
export type ClientWarningLog = (warning: ClientAdapterWarning, adapterVersion: string) => void;

/**
 * The `onWarning` of the client adapters (N69). Every warning goes to `logger.warn`, except
 * `catalog_probe_exempt`, which the adapter emits at every catalog read and which
 * `security.catalog_probe_log` thins out: `once` writes it the first time for each client and
 * adapter version (state lives as long as the returned function, so one run of the daemon),
 * `every` writes all of them and `off` none.
 */
export function clientWarningLog(mode: CatalogProbeLogMode, logger: Logger): ClientWarningLog {
  const seen = new Set<string>();
  return (warning, adapterVersion) => {
    if (warning.kind === 'catalog_probe_exempt') {
      if (mode === 'off') return;
      if (mode === 'once') {
        const key = JSON.stringify([warning.clientId, adapterVersion]);
        if (seen.has(key)) return;
        seen.add(key);
      }
    }
    logger.warn({ client: warning.clientId, warning }, 'client adapter warning');
  };
}
