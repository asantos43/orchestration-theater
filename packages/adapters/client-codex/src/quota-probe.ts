// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  type AdapterImplements,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';

/**
 * The quota probe of Codex, which does not read anything yet. Phase 0 saw the two windows (300 and
 * 10080 minutes) only through `account/rateLimits/read` on the app-server, outside any ACP
 * session [V]; the probe that calls it is Phase 5. Until then `capabilities()` lists no window,
 * which is what it can tell, and `read` rejects with `AdapterUnavailable`.
 */
export class CodexQuotaProbe implements QuotaProbe {
  readonly id = 'codex';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  capabilities(): QuotaCapabilities {
    return { windows: [], delivery: 'poll', precision: 'approximate' };
  }

  read(): Promise<QuotaReading> {
    return Promise.reject(
      new AdapterUnavailable('codex: the quota probe arrives in Phase 5 (account/rateLimits/read)'),
    );
  }
}
