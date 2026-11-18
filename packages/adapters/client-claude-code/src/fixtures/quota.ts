// SPDX-License-Identifier: MPL-2.0
import { STATUSLINE_QUOTA_VERSION } from '../quota-statusline.js';

/**
 * Fixtures of the Claude quota probe (P6). The shapes are the ones Phase 0 measured on the
 * statusline of the interactive client (`spikes/quota-probes/README.md`, item 1, [V]): the stdin
 * of the statusline command, with `rate_limits.five_hour|seven_day` that carry `used_percentage`
 * (integer 0..100) and `resets_at` (epoch seconds). The raw files of that spike are not in the
 * repository (they sit in the ignored `out/`), so every value here is invented and the fields
 * that identify a person or a machine (account, e-mail, paths) are placeholders.
 */

/** The instant the tests treat as "now": 2026-11-18 12:00:00 UTC, epoch ms. */
export const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
/** A reset of the five-hour window two hours from {@link NOW}, epoch seconds. */
export const FIVE_HOUR_RESET_S = (NOW + 2 * 3_600_000) / 1000;
/** A reset of the seven-day window four days from {@link NOW}, epoch seconds. */
export const SEVEN_DAY_RESET_S = (NOW + 4 * 86_400_000) / 1000;

/** The stdin of the statusline command after a reply: more than the quota, all of it invented. */
export const STATUSLINE_STDIN: Readonly<Record<string, unknown>> = {
  session_id: 'session-0000',
  transcript_path: '/example/transcript.jsonl',
  cwd: '/example/work',
  model: { id: 'claude-example', display_name: 'Example' },
  workspace: { current_dir: '/example/work', project_dir: '/example/work' },
  version: '0.0.0',
  cost: { total_cost_usd: 0.01, total_api_duration_ms: 1200 },
  rate_limits: {
    five_hour: { used_percentage: 37, resets_at: FIVE_HOUR_RESET_S },
    seven_day: { used_percentage: 12, resets_at: SEVEN_DAY_RESET_S },
  },
};

/** The first call after the client opens: `rate_limits` is not there yet (Phase 0 [V]). */
export const STATUSLINE_STDIN_NO_LIMITS: Readonly<Record<string, unknown>> = {
  ...STATUSLINE_STDIN,
  rate_limits: null,
};

/** A quota file as the command writes it. */
export function quotaFile(
  rateLimits: unknown,
  observedAt: number = NOW - 60_000,
): Record<string, unknown> {
  return { version: STATUSLINE_QUOTA_VERSION, observed_at: observedAt, rate_limits: rateLimits };
}

/** Both windows, open. */
export const QUOTA_FILE_BOTH = quotaFile({
  five_hour: { used_percentage: 37, resets_at: FIVE_HOUR_RESET_S },
  seven_day: { used_percentage: 12, resets_at: SEVEN_DAY_RESET_S },
});

/** Only the weekly window left: the five-hour one reset and vanished (documented, [S]). */
export const QUOTA_FILE_FIVE_HOUR_OVER = quotaFile({
  five_hour: { used_percentage: 99, resets_at: (NOW - 60_000) / 1000 },
  seven_day: { used_percentage: 12, resets_at: SEVEN_DAY_RESET_S },
});

/** A file with no `rate_limits` at all. */
export const QUOTA_FILE_NO_LIMITS: Readonly<Record<string, unknown>> = {
  version: STATUSLINE_QUOTA_VERSION,
  observed_at: NOW - 60_000,
};

/** A value outside 0..100. */
export const QUOTA_FILE_OUT_OF_RANGE = quotaFile({
  five_hour: { used_percentage: 140, resets_at: FIVE_HOUR_RESET_S },
  seven_day: { used_percentage: 12, resets_at: SEVEN_DAY_RESET_S },
});

/** A `rate_limit_event` of the stream that was rejected (values invented, shape [V] Phase 0 item 9). */
export const RATE_LIMIT_REJECTED_UPDATE: unknown = {
  sessionUpdate: 'usage_update',
  used: 5000,
  size: 200000,
  _meta: {
    '_claude/rateLimit': {
      status: 'rejected',
      resetsAt: FIVE_HOUR_RESET_S,
      rateLimitType: 'five_hour',
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: FIVE_HOUR_RESET_S, status: 'rejected' },
        seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESET_S, status: 'allowed' },
      },
    },
  },
};
