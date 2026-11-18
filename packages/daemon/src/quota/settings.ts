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
