// SPDX-License-Identifier: MPL-2.0
import type { DaemonConfig, QUOTA_PROBE_DELIVERY_MODES } from '../config.js';

export type QuotaProbeDelivery = (typeof QUOTA_PROBE_DELIVERY_MODES)[number];

/**
 * What the `QuotaService` takes of the `quota` section (architecture 5.6). [proposta] The names
 * and defaults come from `config.ts`; N123 (the defaults of the probes) is still open.
 */
export interface QuotaSettings {
  /** Fraction of a window from which the profile is `near_limit` (`quota.near_limit_at`). */
  readonly nearLimitAt: number;
  /** Age, in ms, past which a reading no longer authorizes a route (`quota.stale_after`). */
  readonly staleAfterMs: number;
  /** `quota.probe.delivery`. */
  readonly delivery: QuotaProbeDelivery;
  /** Gap, in ms, between two `read` calls of a profile (`quota.probe.poll_every`). */
  readonly pollEveryMs: number;
}

export function quotaSettingsOf(config: Pick<DaemonConfig, 'quota'>): QuotaSettings {
  const { quota } = config;
  return {
    nearLimitAt: quota.near_limit_at,
    staleAfterMs: quota.stale_after,
    delivery: quota.probe.delivery,
    pollEveryMs: quota.probe.poll_every,
  };
}

/** What the daemon takes of `quota.minimax` to build the MiniMax probe (P8). [proposta] */
export interface QuotaMinimaxSettings {
  readonly mode: DaemonConfig['quota']['minimax']['mode'];
  readonly baseUrl: string;
  readonly allowHosts: readonly string[];
  readonly timeoutMs: number;
  readonly usageCountMeans: DaemonConfig['quota']['minimax']['usage_count_means'];
}

export function quotaMinimaxSettingsOf(config: Pick<DaemonConfig, 'quota'>): QuotaMinimaxSettings {
  const section = config.quota.minimax;
  return {
    mode: section.mode,
    baseUrl: section.base_url,
    allowHosts: section.allow_hosts,
    timeoutMs: section.timeout,
    usageCountMeans: section.usage_count_means,
  };
}

/** What the daemon takes of `quota.opencode` for the local ledger of the OpenCode probe (P8). [proposta] */
export interface QuotaOpencodeSettings {
  readonly mode: DaemonConfig['quota']['opencode']['mode'];
  readonly windowMs: number;
  readonly limitTokens: number | null;
  readonly limitUsd: number | null;
}

export function quotaOpencodeSettingsOf(
  config: Pick<DaemonConfig, 'quota'>,
): QuotaOpencodeSettings {
  const section = config.quota.opencode;
  return {
    mode: section.mode,
    windowMs: section.window,
    limitTokens: section.limit_tokens,
    limitUsd: section.limit_usd,
  };
}
