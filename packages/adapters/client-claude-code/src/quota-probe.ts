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
 * The quota probe of Claude Code. The real one is Phase 5 (architecture 5.6): it will read the
 * statusline JSON that Claude Code writes (`rate_limits`, five-hour and seven-day windows) and the
 * `rate_limit` updates of the session. Until then it says what it can do today, which is nothing
 * outside a session: `capabilities()` lists no window and `read` rejects.
 *
 * What a running session already tells the daemon goes another way: `normalizeUpdate` turns the
 * `rate_limit_event` of the adapter (`usage_update._meta["_claude/rateLimit"]`, [V] Phase 0 item
 * 9) into a `rate_limit` update.
 */
export class ClaudeQuotaProbe implements QuotaProbe {
  readonly id = 'claude-code';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  capabilities(): QuotaCapabilities {
    return { windows: [], delivery: 'poll', precision: 'approximate' };
  }

  read(): Promise<QuotaReading> {
    return Promise.reject(new AdapterUnavailable('quota probe arrives in Phase 5'));
  }
}
