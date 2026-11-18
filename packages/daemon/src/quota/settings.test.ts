// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  QUOTA_MINIMAX_MODES,
  QUOTA_MINIMAX_USAGE_COUNT_MEANS,
  QUOTA_OPENCODE_MODES,
  QUOTA_PROBE_DELIVERY_MODES,
  parseConfig,
} from '../config.js';
import { quotaMinimaxSettingsOf, quotaOpencodeSettingsOf, quotaSettingsOf } from './settings.js';

describe('quota.* keys [proposta]', () => {
  it('defaults to 80% near the limit, 10 minutes of freshness and both ways of reading', () => {
    expect(parseConfig('').quota).toEqual({
      near_limit_at: 0.8,
      stale_after: 600_000,
      probe: { delivery: 'both', poll_every: 300_000 },
      minimax: {
        mode: 'off',
        base_url: 'https://api.minimax.io',
        allow_hosts: ['api.minimax.io', 'www.minimax.io'],
        timeout: 10_000,
        usage_count_means: 'remaining',
      },
      opencode: { mode: 'off', window: 18_000_000, limit_tokens: null, limit_usd: null },
    });
    expect(quotaSettingsOf(parseConfig(''))).toEqual({
      nearLimitAt: 0.8,
      staleAfterMs: 600_000,
      delivery: 'both',
      pollEveryMs: 300_000,
    });
  });

  it('takes every delivery mode, and a duration for the freshness', () => {
    for (const mode of QUOTA_PROBE_DELIVERY_MODES) {
      expect(parseConfig(`quota:\n  probe:\n    delivery: ${mode}\n`).quota.probe.delivery).toBe(
        mode,
      );
    }
    const config = parseConfig('quota:\n  near_limit_at: 0.5\n  stale_after: 2m\n');
    expect(quotaSettingsOf(config)).toMatchObject({ nearLimitAt: 0.5, staleAfterMs: 120_000 });
  });

  it('refuses a fraction outside (0, 1], a bad delivery and an unknown key', () => {
    expect(() => parseConfig('quota:\n  near_limit_at: 0\n')).toThrow(/near_limit_at/);
    expect(() => parseConfig('quota:\n  near_limit_at: 1.5\n')).toThrow(/near_limit_at/);
    expect(() => parseConfig('quota:\n  probe:\n    delivery: sometimes\n')).toThrow(/delivery/);
    expect(() => parseConfig('quota:\n  nope: 1\n')).toThrow(/nope/);
  });
});

describe('quota.minimax and quota.opencode keys [proposta] (P8)', () => {
  it('are off by default, so no call leaves the machine and no ledger runs', () => {
    expect(quotaMinimaxSettingsOf(parseConfig(''))).toEqual({
      mode: 'off',
      baseUrl: 'https://api.minimax.io',
      allowHosts: ['api.minimax.io', 'www.minimax.io'],
      timeoutMs: 10_000,
      usageCountMeans: 'remaining',
    });
    expect(quotaOpencodeSettingsOf(parseConfig(''))).toEqual({
      mode: 'off',
      windowMs: 5 * 3_600_000,
      limitTokens: null,
      limitUsd: null,
    });
  });

  it('take every mode, durations and limits', () => {
    for (const mode of QUOTA_MINIMAX_MODES) {
      expect(parseConfig(`quota:\n  minimax:\n    mode: ${mode}\n`).quota.minimax.mode).toBe(mode);
    }
    for (const means of QUOTA_MINIMAX_USAGE_COUNT_MEANS) {
      expect(
        parseConfig(`quota:\n  minimax:\n    usage_count_means: ${means}\n`).quota.minimax
          .usage_count_means,
      ).toBe(means);
    }
    for (const mode of QUOTA_OPENCODE_MODES) {
      expect(parseConfig(`quota:\n  opencode:\n    mode: ${mode}\n`).quota.opencode.mode).toBe(
        mode,
      );
    }
    const config = parseConfig(
      'quota:\n  minimax:\n    timeout: 3s\n    allow_hosts: [example.test]\n  opencode:\n    mode: ledger\n    window: 1h\n    limit_tokens: 2000000\n    limit_usd: 12.5\n',
    );
    expect(quotaMinimaxSettingsOf(config)).toMatchObject({
      timeoutMs: 3000,
      allowHosts: ['example.test'],
    });
    expect(quotaOpencodeSettingsOf(config)).toEqual({
      mode: 'ledger',
      windowMs: 3_600_000,
      limitTokens: 2_000_000,
      limitUsd: 12.5,
    });
  });

  it('refuse a bad mode, a bad limit, a bad address and an unknown key', () => {
    expect(() => parseConfig('quota:\n  minimax:\n    mode: always\n')).toThrow(/mode/);
    expect(() => parseConfig('quota:\n  minimax:\n    base_url: not a url\n')).toThrow(/base_url/);
    expect(() => parseConfig('quota:\n  minimax:\n    usage_count_means: half\n')).toThrow(
      /usage_count_means/,
    );
    expect(() => parseConfig('quota:\n  opencode:\n    limit_tokens: 0\n')).toThrow(/limit_tokens/);
    expect(() => parseConfig('quota:\n  opencode:\n    limit_usd: -1\n')).toThrow(/limit_usd/);
    expect(() => parseConfig('quota:\n  opencode:\n    window: soon\n')).toThrow(/window/);
    expect(() => parseConfig('quota:\n  minimax:\n    nope: 1\n')).toThrow(/nope/);
  });
});
