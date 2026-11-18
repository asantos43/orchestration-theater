// SPDX-License-Identifier: MPL-2.0
import type {
  ClientAdapterContract,
  Clock,
  ProfileRef,
  QuotaProbe,
  SecretVault,
  Store,
} from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { profileApiKey, profileProvider } from '../profiles/secret-env.js';
import { MiniMaxQuotaProbe } from './minimax-probe.js';
import { ProviderQuotaProbe, type LedgerProbe } from './provider-probe.js';
import { quotaMinimaxSettingsOf, quotaOpencodeSettingsOf } from './settings.js';

export interface QuotaWiringDeps {
  readonly config: Pick<DaemonConfig, 'quota'>;
  readonly store: Pick<Store, 'profiles'>;
  readonly vault: SecretVault;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** Where the probe writes what it only logged (`quota.probe_failed`, P24). */
  readonly situations?: SituationSink | undefined;
}

/** The probe the service gets for a client, and what the daemon does before the service starts. */
export interface QuotaProbeWiring {
  readonly probe: QuotaProbe;
  /**
   * Only when the probe was built here: looks the provider of each profile of the client up and
   * returns them, so the daemon can `track` them before the service starts (until then a profile
   * is tracked only once a session of it opens).
   */
  readonly prepare?: () => Promise<readonly ProfileRef[]>;
}

/** The ledger a client carries (`quota.opencode.mode: ledger`), or `undefined` when it has none. */
function ledgerOf(probe: QuotaProbe): LedgerProbe | undefined {
  const candidate = probe as Partial<LedgerProbe>;
  return typeof candidate.recordUsage === 'function' ? (probe as LedgerProbe) : undefined;
}

/**
 * Chooses the quota probe of a client (P8, architecture 5.6). With `quota.minimax.mode` and
 * `quota.opencode.mode` both `off` (the defaults), and for every client other than OpenCode, it is
 * the probe the client brings, untouched: nothing changes for anyone who did not turn them on.
 * For OpenCode with either one on, it is a {@link ProviderQuotaProbe}: a MiniMax profile is read at
 * the Token Plan endpoint (a call the daemon makes, under its network policy), the others in the
 * local ledger of the client's own probe.
 */
export function quotaProbeOf(
  client: Pick<ClientAdapterContract, 'id' | 'quota'>,
  deps: QuotaWiringDeps,
): QuotaProbeWiring {
  if (client.id !== 'opencode') return { probe: client.quota };
  const minimaxSettings = quotaMinimaxSettingsOf(deps.config);
  const ledger =
    quotaOpencodeSettingsOf(deps.config).mode === 'ledger' ? ledgerOf(client.quota) : undefined;
  const minimax =
    minimaxSettings.mode === 'token_plan'
      ? new MiniMaxQuotaProbe({
          baseUrl: minimaxSettings.baseUrl,
          network: {
            allowHosts: minimaxSettings.allowHosts,
            timeoutMs: minimaxSettings.timeoutMs,
          },
          usageCountMeans: minimaxSettings.usageCountMeans,
          keyOf: profileApiKey({
            store: deps.store,
            vault: deps.vault,
            logger: deps.logger,
            situations: deps.situations,
          }),
          clock: deps.clock,
          logger: deps.logger,
          situations: deps.situations,
        })
      : undefined;
  if (ledger === undefined && minimax === undefined) return { probe: client.quota };
  const probe = new ProviderQuotaProbe({
    ...(ledger === undefined ? {} : { ledger }),
    ...(minimax === undefined ? {} : { minimax }),
    providerOf: profileProvider({ store: deps.store }),
  });
  return {
    probe,
    prepare: async () => {
      const records = await deps.store.profiles.list({
        client: client.id,
        states: ['active', 'draining'],
      });
      const refs = records.map((record) => ({ client: record.client, profile: record.name }));
      await probe.warm(refs);
      return refs;
    },
  };
}
