// SPDX-License-Identifier: MPL-2.0
import {
  builtInPricing,
  mergePricing,
  type ModelPrice,
  type PriceRates,
  type PricingTable,
} from '@otheater/core';
import type {
  DaemonConfig,
  ModelPriceConfig,
  USAGE_COST_SOURCE_MODES,
  USAGE_SUBSCRIPTION_DISPLAY_MODES,
} from '../config.js';

export type UsageSubscriptionDisplay = (typeof USAGE_SUBSCRIPTION_DISPLAY_MODES)[number];
export type UsageCostSourceMode = (typeof USAGE_COST_SOURCE_MODES)[number];

/** What the `UsageService` takes of the `usage` and `pricing` sections (architecture 5.6). */
export interface UsageSettings {
  /** `usage.subscription_display`. */
  readonly subscriptionDisplay: UsageSubscriptionDisplay;
  /** `usage.cost_source`, as written. `provider_billing` has no adapter and works as the default. */
  readonly costSource: UsageCostSourceMode;
  /** `usage.monthly_price_usd`: the monthly price of the plan, by profile id. */
  readonly monthlyPriceUsd: ReadonlyMap<string, number>;
  /** The table that ships with the version, with the `pricing` entries of the config over it. */
  readonly pricing: PricingTable;
}

function ratesOf(config: {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok?: number | undefined;
  cache_write_per_mtok?: number | undefined;
}): PriceRates {
  return {
    inputPerMtok: config.input_per_mtok,
    outputPerMtok: config.output_per_mtok,
    cacheReadPerMtok: config.cache_read_per_mtok,
    cacheWritePerMtok: config.cache_write_per_mtok,
  };
}

/** One `pricing.<model>` entry of the config as a {@link ModelPrice}. */
export function modelPriceOf(config: ModelPriceConfig): ModelPrice {
  return {
    ...ratesOf(config),
    cachedInInput: config.cached_in_input,
    longContext:
      config.long_context === undefined
        ? undefined
        : { overTokens: config.long_context.over_tokens, rates: ratesOf(config.long_context) },
  };
}

export function usageSettingsOf(config: Pick<DaemonConfig, 'usage' | 'pricing'>): UsageSettings {
  const overrides = Object.fromEntries(
    Object.entries(config.pricing).map(([model, price]) => [model, modelPriceOf(price)]),
  );
  return {
    subscriptionDisplay: config.usage.subscription_display,
    costSource: config.usage.cost_source,
    monthlyPriceUsd: new Map(Object.entries(config.usage.monthly_price_usd)),
    pricing: mergePricing(builtInPricing(), overrides),
  };
}
