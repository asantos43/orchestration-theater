// SPDX-License-Identifier: MPL-2.0

/**
 * The `pricing` table (architecture 5.6, Phase 5 P10): what a model costs by API, in US$ per
 * million tokens (MTok). It ships with each version (`builtInPricing`) and the configuration
 * overrides it entry by entry (`mergePricing`). A model that is not in the table has no price: its
 * cost is unknown, never US$ 0 (the rule of the `budget` package of the Claudexor, N119, kept as
 * a rule only: no code was taken from it).
 */

/** The prices a token can be billed at. The cache prices are optional: not every model has them. */
export interface PriceRates {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  /** Price of a prompt token read from the provider cache (a "cache hit"). */
  readonly cacheReadPerMtok?: number | undefined;
  /** Price of a prompt token written to the provider cache (the 5-minute write, for Anthropic). */
  readonly cacheWritePerMtok?: number | undefined;
}

/** Where a price came from: the official page of the provider and the day it was read. */
export interface PriceSource {
  readonly url: string;
  /** `YYYY-MM-DD`, the day the page was consulted. */
  readonly consultedOn: string;
}

export interface ModelPrice extends PriceRates {
  /**
   * How the client counts tokens. `false` (Anthropic): `inputTokens` leaves out the cache tokens,
   * which are counted apart. `true` (OpenAI): `inputTokens` already includes the cached ones, so
   * the cache read is billed at its own price and taken off the fresh input.
   */
  readonly cachedInInput?: boolean | undefined;
  /** A second rate card for a long prompt (Haiku 5.5, above 100,000 tokens). */
  readonly longContext?:
    | {
        /** The rate card applies when the prompt has MORE than this many tokens. */
        readonly overTokens: number;
        readonly rates: PriceRates;
      }
    | undefined;
  /** Required for the built-in entries (N125); optional for an entry written in the config. */
  readonly source?: PriceSource | undefined;
}

/** `built_in` entries come with the version; `config` ones were written (or overridden) by the owner. */
export type PriceOrigin = 'built_in' | 'config';

export interface PricingEntry {
  readonly price: ModelPrice;
  readonly origin: PriceOrigin;
}

export interface PricingTable {
  /** Version of the built-in table the entries started from. */
  readonly version: string;
  /** Model id (normalized, see `normalizeModelId`) to its entry. */
  readonly models: ReadonlyMap<string, PricingEntry>;
}

/** Version of the table that ships with this release: the day its prices were consulted. */
export const BUILT_IN_PRICING_VERSION = '2026-11-18';

const CONSULTED_ON = '2026-11-18';
const anthropic: PriceSource = {
  url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  consultedOn: CONSULTED_ON,
};
const openai: PriceSource = {
  url: 'https://developers.openai.com/api/docs/pricing',
  consultedOn: CONSULTED_ON,
};

/**
 * The models of the `quality` preset (N125, decided by the owner on 2026-11-18), each with the
 * source and the day it was read, taken only from the official pricing pages of the providers [S].
 * The owner still confirms the values. Left out on purpose (cost `unknown`): `minimax-m2` (the
 * official page lists no M2) and `gemma4` (a local model, no API price). The Claude cache write is
 * the 5-minute one (the default TTL); the 1-hour write costs more and is not used. `codex-sol` and
 * `codex-luna` are priced as `gpt-6-sol` and `gpt-6-luna` (architecture 5.7, [a confirmar]).
 */
export const BUILT_IN_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': {
    inputPerMtok: 4,
    outputPerMtok: 20,
    cacheReadPerMtok: 0.2,
    cacheWritePerMtok: 5,
    source: anthropic,
  },
  'claude-sonnet-5-5': {
    inputPerMtok: 2,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.1,
    cacheWritePerMtok: 2.5,
    source: anthropic,
  },
  'claude-haiku-5-5': {
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cacheReadPerMtok: 0.01,
    cacheWritePerMtok: 0.125,
    longContext: {
      overTokens: 100_000,
      rates: {
        inputPerMtok: 0.5,
        outputPerMtok: 2.5,
        cacheReadPerMtok: 0.05,
        cacheWritePerMtok: 0.625,
      },
    },
    source: anthropic,
  },
  'gpt-6-sol': {
    inputPerMtok: 2,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.2,
    cachedInInput: true,
    source: openai,
  },
  'gpt-6-luna': {
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cacheReadPerMtok: 0.01,
    cachedInInput: true,
    source: openai,
  },
};

/** The built-in table, with no override. */
export function builtInPricing(): PricingTable {
  return {
    version: BUILT_IN_PRICING_VERSION,
    models: new Map(
      Object.entries(BUILT_IN_MODEL_PRICES).map(([model, price]) => [
        model,
        { price, origin: 'built_in' } satisfies PricingEntry,
      ]),
    ),
  };
}

/**
 * The model id as the table keys it: lower case, no provider prefix (`anthropic/claude-opus-5-5`),
 * no bracket suffix (`[1m]`), no date suffix (`-20261101`), dots as dashes (`claude-opus-5.5`).
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/\[[^\]]*\]$/, '');
  id = id.replace(/-\d{8}$/, '');
  return id.replaceAll('.', '-');
}

/**
 * Lays the entries of the config over a table: an entry with the id of a model replaces it whole,
 * a new id adds a model. The ids are normalized the way `findPrice` looks them up.
 */
export function mergePricing(
  base: PricingTable,
  overrides: Readonly<Record<string, ModelPrice>>,
): PricingTable {
  const models = new Map(base.models);
  for (const [model, price] of Object.entries(overrides)) {
    models.set(normalizeModelId(model), { price, origin: 'config' });
  }
  return { version: base.version, models };
}
