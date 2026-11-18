// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapterWarning } from '@otheater/core';
import type { CATALOG_PROBE_LOG_MODES } from './config.js';
import type { Logger } from './logger.js';
import { situationSubject, situationText, type SituationSink } from './situations.js';

export type CatalogProbeLogMode = (typeof CATALOG_PROBE_LOG_MODES)[number];

/** Takes what an adapter warns of and writes it to the daemon log. */
export type ClientWarningLog = (warning: ClientAdapterWarning, adapterVersion: string) => void;

/**
 * [proposta] The `detail` of the `daemon.notice` of a warning (P24): its kind and the facts the log
 * line carries, in one short line (field names, probe id, versions), never the raw error.
 */
function warningDetail(warning: ClientAdapterWarning): string | null {
  switch (warning.kind) {
    case 'client_version_corrected':
      return situationText(
        `${warning.kind}: ${warning.from.version} -> ${warning.to.version} (${warning.agentName})`,
      );
    case 'conformance_probe_threw':
      return situationText(
        `${warning.kind}: ${warning.probeId}: ${situationText(warning.error, 200) ?? ''}`,
      );
    case 'unenforced':
    case 'catalog_probe_exempt':
      return situationText(`${warning.kind}: ${warning.short.join(', ')}`);
  }
}

/**
 * The `onWarning` of the client adapters (N69). Every warning goes to `logger.warn`, except
 * `client_version_corrected` (N63, an `info`: the `initialize` replaced the version read from the
 * files) and `catalog_probe_exempt`, which the adapter emits at every catalog read and which
 * `security.catalog_probe_log` thins out: `once` writes it the first time for each client and
 * adapter version (state lives as long as the returned function, so one run of the daemon),
 * `every` writes all of them and `off` none.
 *
 * P24 (N146): what is written to the log is also a `daemon.notice` of kind `client_warning`, at the
 * same point, so what `catalog_probe_log` thins out is thinned out in the event too.
 */
export function clientWarningLog(
  mode: CatalogProbeLogMode,
  logger: Logger,
  situations?: SituationSink,
): ClientWarningLog {
  const seen = new Set<string>();
  const notice = (warning: ClientAdapterWarning): void => {
    situations?.record('daemon.notice', {
      kind: 'client_warning',
      subject: situationSubject(warning.clientId),
      detail: warningDetail(warning),
    });
  };
  return (warning, adapterVersion) => {
    if (warning.kind === 'client_version_corrected') {
      // Not a fault: the version the client reported replaced the one read from its files (N63).
      logger.info(
        {
          client: warning.clientId,
          from: warning.from,
          to: warning.to,
          adapterVersion: warning.adapterVersion,
          agentName: warning.agentName,
        },
        'client version corrected by the initialize',
      );
      notice(warning);
      return;
    }
    if (warning.kind === 'catalog_probe_exempt') {
      if (mode === 'off') return;
      if (mode === 'once') {
        const key = JSON.stringify([warning.clientId, adapterVersion]);
        if (seen.has(key)) return;
        seen.add(key);
      }
    }
    logger.warn({ client: warning.clientId, warning }, 'client adapter warning');
    notice(warning);
  };
}
