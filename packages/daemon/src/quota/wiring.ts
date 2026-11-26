// SPDX-License-Identifier: MPL-2.0
import {
  formatProfileId,
  type ClientAdapterContract,
  type Clock,
  type ProfileRecord,
  type ProfileRef,
  type QuotaProbe,
  type SecretVault,
  type Store,
} from '@otheater/core';
import type { DaemonConfig, QuotaTrackMode } from '../config.js';
import type { Logger } from '../logger.js';
import type { SituationSink } from '../situations.js';
import { profileApiKey, profileProvider } from '../profiles/secret-env.js';
import { MiniMaxQuotaProbe } from './minimax-probe.js';
import { ProviderQuotaProbe, type LedgerProbe } from './provider-probe.js';
import { quotaMinimaxSettingsOf, quotaOpencodeSettingsOf } from './settings.js';

export interface QuotaWiringDeps {
  readonly config: Pick<DaemonConfig, 'quota'> & {
    readonly profiles?: Pick<DaemonConfig['profiles'], 'entries'> | undefined;
  };
  readonly store: Pick<Store, 'profiles'>;
  readonly vault: SecretVault;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  /** Where the probe writes what it only logged (`quota.probe_failed`, P24). */
  readonly situations?: SituationSink | undefined;
  /**
   * The quota probe of Codex (P25, N156), for the OpenCode profiles that declare `codex_link`;
   * `undefined` when Codex is not on.
   */
  readonly codexQuota?: QuotaProbe | undefined;
}

/**
 * The Codex profile an OpenCode profile is linked to (`profiles.<id>.codex_link`), whatever the
 * mode of the quota; the selector uses it to take the two as one account (P25).
 */
export function codexLinkOf(
  config: { readonly profiles?: Pick<DaemonConfig['profiles'], 'entries'> | undefined },
  profile: ProfileRef,
): string | undefined {
  if (profile.client !== 'opencode') return undefined;
  return config.profiles?.entries[formatProfileId(profile)]?.codex_link;
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

/** The ledger a client carries (`quota.opencode.mode` `ledger` or `auto`), or `undefined` when it has none. */
function ledgerOf(probe: QuotaProbe): LedgerProbe | undefined {
  const candidate = probe as Partial<LedgerProbe>;
  return typeof candidate.recordUsage === 'function' ? (probe as LedgerProbe) : undefined;
}

/**
 * Chooses the quota probe of a client (P8, architecture 5.6). For every client other than
 * OpenCode it is the probe the client brings, untouched; for OpenCode too, while there is nothing
 * to route (the defaults: no MiniMax probe, no limit of the ledger, no `codex_link`), so nothing
 * changes for anyone who did not configure them. Otherwise it is a {@link ProviderQuotaProbe}: a
 * MiniMax profile is read at the Token Plan endpoint (a call the daemon makes, under its network
 * policy), a profile with `codex_link` through the probe of Codex for the linked profile (P25,
 * modes `auto` and `codex_link`), the others in the local ledger of the client's own probe (modes
 * `auto` and `ledger`).
 */
export function quotaProbeOf(
  client: Pick<ClientAdapterContract, 'id' | 'quota'>,
  deps: QuotaWiringDeps,
): QuotaProbeWiring {
  if (client.id !== 'opencode') return { probe: client.quota };
  const minimaxSettings = quotaMinimaxSettingsOf(deps.config);
  const mode = quotaOpencodeSettingsOf(deps.config).mode;
  const carried = mode === 'ledger' || mode === 'auto' ? ledgerOf(client.quota) : undefined;
  // In `auto` a ledger with no limit has nothing to say; `ledger` keeps it as P8 did.
  const ledger =
    mode === 'auto' && carried?.capabilities().windows.length === 0 ? undefined : carried;
  const linking = mode === 'auto' || mode === 'codex_link';
  const linked =
    linking &&
    Object.entries(deps.config.profiles?.entries ?? {}).some(
      ([id, entry]) => id.startsWith('opencode/') && entry.codex_link !== undefined,
    );
  const codex = linked ? deps.codexQuota : undefined;
  if (linked && codex === undefined) {
    deps.logger.warn(
      {},
      'an OpenCode profile declares codex_link, but Codex is not on: its quota has no reading',
    );
    deps.situations?.record('daemon.notice', {
      kind: 'client_warning',
      subject: 'opencode',
      detail: 'codex_link_without_codex',
    });
  }
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
  if (ledger === undefined && minimax === undefined && codex === undefined) {
    return { probe: client.quota };
  }
  const probe = new ProviderQuotaProbe({
    ...(ledger === undefined ? {} : { ledger }),
    ...(minimax === undefined ? {} : { minimax }),
    ...(codex === undefined
      ? {}
      : { codex, linkOf: (profile: ProfileRef) => codexLinkOf(deps.config, profile) }),
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

/** The states of a subscription the service reads with `quota.track` `always`. */
const TRACKED_STATES = ['active', 'draining'] as const;

/**
 * [proposta] `quota.track` `always` (2026-11-26): the subscriptions (`token_plan`) the service
 * reads from the start, of one client or of all. `on_session` returns none: an account is then read
 * once a session of it opens.
 */
export async function subscriptionsToTrack(
  store: Pick<Store, 'profiles'>,
  mode: QuotaTrackMode,
  client?: string,
): Promise<readonly ProfileRef[]> {
  if (mode !== 'always') return [];
  const records = await store.profiles.list({
    kind: 'token_plan',
    states: TRACKED_STATES,
    ...(client === undefined ? {} : { client }),
  });
  return records.map((record) => ({ client: record.client, profile: record.name }));
}

/**
 * [proposta] `quota.track` `always`: the account just registered, when the service is to read it
 * now (a subscription that is active or draining); `undefined` otherwise.
 */
export function addedSubscriptionToTrack(
  mode: QuotaTrackMode,
  record: Pick<ProfileRecord, 'client' | 'name' | 'kind' | 'state'>,
): ProfileRef | undefined {
  if (mode !== 'always' || record.kind !== 'token_plan') return undefined;
  if (!(TRACKED_STATES as readonly string[]).includes(record.state)) return undefined;
  return { client: record.client, profile: record.name };
}
