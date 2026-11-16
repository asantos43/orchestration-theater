// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  type AdapterImplements,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';

/**
 * The quota probe of OpenCode. The real one is a Phase 5 piece (architecture 5.6): OpenCode has no
 * quota of its own, the limit belongs to the provider behind the model, and the only source Phase
 * 0 found is the `cost` of `usage_update` [V], which is spending, not a window. So this probe says
 * what it will be able to tell (nothing yet: no windows, polling, approximate) and refuses to read.
 */
export class OpenCodeQuotaProbe implements QuotaProbe {
  readonly id = 'opencode-quota';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  capabilities(): QuotaCapabilities {
    return { windows: [], delivery: 'poll', precision: 'approximate' };
  }

  read(profile: ProfileRef): Promise<QuotaReading> {
    return Promise.reject(
      new AdapterUnavailable(
        `quota probe arrives in Phase 5 (no reading for ${profile.client}/${profile.profile})`,
      ),
    );
  }
}
