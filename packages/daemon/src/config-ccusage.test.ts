// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  USAGE_CCUSAGE_COMMAND_MODES,
  USAGE_CCUSAGE_COMPARE_MODES,
  USAGE_CCUSAGE_PRICING_MODES,
  parseConfig,
} from './config.js';
import { usageAuditSettingsOf } from './usage/settings.js';

describe('usage.ccusage keys [proposta] (P12, N118)', () => {
  it('is off by default, with explicit mode, version 20.0.48 and offline prices', () => {
    const c = parseConfig('').usage.ccusage;
    expect(c).toEqual({
      enabled: false,
      command_mode: 'explicit',
      version: '20.0.48',
      timeout: 30_000,
      pricing: 'offline',
      compare: 'tokens',
      tolerance: 0.1,
      min_tokens: 1000,
      min_usd: 0.5,
      interval: 3_600_000,
      window_days: 7,
    });
    expect(usageAuditSettingsOf(parseConfig(''))).toEqual({
      compare: 'tokens',
      tolerance: 0.1,
      minTokens: 1000,
      minUsd: 0.5,
      intervalMs: 3_600_000,
      windowDays: 7,
    });
  });

  it('takes every mode', () => {
    for (const mode of USAGE_CCUSAGE_PRICING_MODES) {
      expect(parseConfig(`usage:\n  ccusage:\n    pricing: ${mode}\n`).usage.ccusage.pricing).toBe(
        mode,
      );
    }
    for (const mode of USAGE_CCUSAGE_COMPARE_MODES) {
      expect(parseConfig(`usage:\n  ccusage:\n    compare: ${mode}\n`).usage.ccusage.compare).toBe(
        mode,
      );
    }
    expect(USAGE_CCUSAGE_COMMAND_MODES).toEqual(['explicit', 'path']);
  });

  it('enabled in explicit mode needs an absolute command: no accidental PATH lookup', () => {
    expect(() => parseConfig('usage:\n  ccusage:\n    enabled: true\n')).toThrow(/absolute path/);
    expect(() =>
      parseConfig('usage:\n  ccusage:\n    enabled: true\n    command: ccusage\n'),
    ).toThrow(/absolute path/);
    const ok = parseConfig(
      'usage:\n  ccusage:\n    enabled: true\n    command: /opt/ccusage/ccusage\n',
    );
    expect(ok.usage.ccusage.command).toBe('/opt/ccusage/ccusage');
  });

  it('path mode takes a bare name or none, and refuses a folder', () => {
    expect(
      parseConfig('usage:\n  ccusage:\n    enabled: true\n    command_mode: path\n').usage.ccusage
        .command,
    ).toBeUndefined();
    expect(() =>
      parseConfig(
        'usage:\n  ccusage:\n    enabled: true\n    command_mode: path\n    command: /usr/bin/ccusage\n',
      ),
    ).toThrow(/bare name/);
  });

  it('refuses a wrong shape', () => {
    expect(() => parseConfig('usage:\n  ccusage:\n    version: latest\n')).toThrow();
    expect(() => parseConfig('usage:\n  ccusage:\n    tolerance: 2\n')).toThrow();
    expect(() => parseConfig('usage:\n  ccusage:\n    window_days: 0\n')).toThrow();
    expect(() => parseConfig('usage:\n  ccusage:\n    nope: 1\n')).toThrow();
    expect(parseConfig('usage:\n  ccusage:\n    interval: 0\n').usage.ccusage.interval).toBe(0);
  });
});
