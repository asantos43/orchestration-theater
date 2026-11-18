// SPDX-License-Identifier: MPL-2.0
import { BUILT_IN_PRICING_VERSION, priceTokens } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  USAGE_API_GATEWAY_MODES,
  USAGE_COST_SOURCE_MODES,
  USAGE_SUBSCRIPTION_DISPLAY_MODES,
  parseConfig,
} from '../config.js';
import { usageSettingsOf } from './settings.js';

describe('usage.* and pricing keys [proposta]', () => {
  it('defaults to quota and equivalent, client then pricing, no gateway and no override', () => {
    const config = parseConfig('');
    expect(config.usage).toEqual({
      subscription_display: 'quota_and_equivalent',
      cost_source: 'client_then_pricing',
      api_gateway: 'off',
      monthly_price_usd: {},
      ccusage: expect.objectContaining({ enabled: false }) as unknown,
    });
    expect(config.pricing).toEqual({});
    const settings = usageSettingsOf(config);
    expect(settings).toMatchObject({
      subscriptionDisplay: 'quota_and_equivalent',
      costSource: 'client_then_pricing',
    });
    expect(settings.monthlyPriceUsd.size).toBe(0);
    expect(settings.pricing.version).toBe(BUILT_IN_PRICING_VERSION);
    expect(settings.pricing.models.has('claude-opus-5-5')).toBe(true);
  });

  it('takes every mode of the display and of the cost source', () => {
    for (const mode of USAGE_SUBSCRIPTION_DISPLAY_MODES) {
      const config = parseConfig(`usage:\n  subscription_display: ${mode}\n`);
      expect(config.usage.subscription_display).toBe(mode);
    }
    for (const mode of USAGE_COST_SOURCE_MODES) {
      expect(parseConfig(`usage:\n  cost_source: ${mode}\n`).usage.cost_source).toBe(mode);
    }
    expect(USAGE_API_GATEWAY_MODES).toEqual(['off']);
  });

  it('accepts provider_billing in the config (no adapter yet) and the monthly price of a plan', () => {
    const config = parseConfig(
      'usage:\n  cost_source: provider_billing\n  monthly_price_usd:\n    claude-code/work: 200\n',
    );
    const settings = usageSettingsOf(config);
    expect(settings.costSource).toBe('provider_billing');
    expect(settings.monthlyPriceUsd.get('claude-code/work')).toBe(200);
  });

  it('lays a pricing entry over the table that ships, and adds a model to it', () => {
    const config = parseConfig(
      [
        'pricing:',
        '  claude-opus-5-5:',
        '    input_per_mtok: 1',
        '    output_per_mtok: 2',
        '  my-model:',
        '    input_per_mtok: 3',
        '    output_per_mtok: 4',
        '    long_context:',
        '      over_tokens: 1000',
        '      input_per_mtok: 6',
        '      output_per_mtok: 8',
      ].join('\n'),
    );
    const { pricing } = usageSettingsOf(config);
    expect(
      priceTokens(pricing, 'claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toMatchObject({ usd: 3, pricingVersion: `${BUILT_IN_PRICING_VERSION}+config` });
    expect(
      priceTokens(pricing, 'my-model', { inputTokens: 2000, outputTokens: 1000 })?.usd,
    ).toBeCloseTo((2000 * 6 + 1000 * 8) / 1e6, 12);
    // What the config did not touch keeps the version of the table that ships.
    expect(
      priceTokens(pricing, 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toMatchObject({ usd: 2, pricingVersion: BUILT_IN_PRICING_VERSION });
  });

  it('refuses a bad mode, a gateway that is not off, a negative price and an unknown key', () => {
    expect(() => parseConfig('usage:\n  subscription_display: always\n')).toThrow(
      /subscription_display/,
    );
    expect(() => parseConfig('usage:\n  cost_source: guess\n')).toThrow(/cost_source/);
    expect(() => parseConfig('usage:\n  api_gateway: litellm\n')).toThrow(/api_gateway/);
    expect(() => parseConfig('usage:\n  monthly_price_usd:\n    claude-code/work: 0\n')).toThrow();
    expect(() =>
      parseConfig('pricing:\n  m:\n    input_per_mtok: -1\n    output_per_mtok: 1\n'),
    ).toThrow(/input_per_mtok/);
    expect(() => parseConfig('pricing:\n  m:\n    input_per_mtok: 1\n')).toThrow(/output_per_mtok/);
    expect(() => parseConfig('usage:\n  nope: 1\n')).toThrow(/nope/);
  });
});
