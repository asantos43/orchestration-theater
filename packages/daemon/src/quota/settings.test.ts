// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { QUOTA_PROBE_DELIVERY_MODES, parseConfig } from '../config.js';
import { quotaSettingsOf } from './settings.js';
import { wakeupSettingsOf } from './wakeups.js';

describe('quota.* keys [proposta]', () => {
  it('defaults to 80% near the limit, 10 minutes of freshness and both ways of reading', () => {
    expect(parseConfig('').quota).toEqual({
      near_limit_at: 0.8,
      stale_after: 600_000,
      recheck_every: 900_000,
      probe: { delivery: 'both', poll_every: 300_000 },
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

  it('takes quota.recheck_every as a duration, 15m by default, and off as no recheck [proposta]', () => {
    expect(wakeupSettingsOf(parseConfig(''))).toEqual({ recheckEveryMs: 900_000 });
    expect(wakeupSettingsOf(parseConfig('quota:\n  recheck_every: 2m\n'))).toEqual({
      recheckEveryMs: 120_000,
    });
    expect(wakeupSettingsOf(parseConfig('quota:\n  recheck_every: off\n'))).toEqual({
      recheckEveryMs: null,
    });
    expect(() => parseConfig('quota:\n  recheck_every: sometimes\n')).toThrow(/recheck_every/);
    expect(() => parseConfig('quota:\n  recheck_every: 0\n')).toThrow(/recheck_every/);
  });

  it('refuses a fraction outside (0, 1], a bad delivery and an unknown key', () => {
    expect(() => parseConfig('quota:\n  near_limit_at: 0\n')).toThrow(/near_limit_at/);
    expect(() => parseConfig('quota:\n  near_limit_at: 1.5\n')).toThrow(/near_limit_at/);
    expect(() => parseConfig('quota:\n  probe:\n    delivery: sometimes\n')).toThrow(/delivery/);
    expect(() => parseConfig('quota:\n  nope: 1\n')).toThrow(/nope/);
  });
});
