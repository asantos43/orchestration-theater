// SPDX-License-Identifier: MPL-2.0
import {
  normalizeModelId,
  type ModelPrice,
  type PriceRates,
  type PricingEntry,
  type PricingTable,
} from './table.js';

/** What a turn (or a call) consumed. A count the client did not report is left out, never 0. */
export interface TokenCounts {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

/** What `priceTokens` answers: the cost and the version of the table it came from. */
export interface PricedTokens {
  readonly usd: number;
  /** The built-in version, with `+config` when the entry came from (or was overridden by) the config. */
  readonly pricingVersion: string;
  /** The key of the entry that was used. */
  readonly model: string;
}

const MTOK = 1_000_000;

/** The entry of a model, or `undefined` when the table has no price for it. */
export function findPrice(
  table: PricingTable,
  model: string | undefined,
): { readonly model: string; readonly entry: PricingEntry } | undefined {
  if (model === undefined) return undefined;
  const key = normalizeModelId(model);
  const entry = table.models.get(key);
  return entry === undefined ? undefined : { model: key, entry };
}

/** The version a cost is recorded under: the table's, marked when the config touched the entry. */
export function pricingVersionOf(table: PricingTable, entry: PricingEntry): string {
  return entry.origin === 'config' ? `${table.version}+config` : table.version;
}

function ratesFor(price: ModelPrice, promptTokens: number): PriceRates {
  const long = price.longContext;
  return long !== undefined && promptTokens > long.overTokens ? long.rates : price;
}

/**
 * The cost of `tokens` at `price`, in US$, or `undefined` when it cannot be known: the input or
 * the output count is missing, or the turn has cache tokens and the entry has no price for them.
 * An unknown cost is never US$ 0 [proposta]; a cache count that is left out is taken as 0, because
 * a client that does not report a cache did not use one in the count.
 */
export function costOfTokens(price: ModelPrice, tokens: TokenCounts): number | undefined {
  const { inputTokens, outputTokens } = tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const cachedInInput = price.cachedInInput === true;
  const promptTokens = cachedInInput ? inputTokens : inputTokens + cacheRead + cacheWrite;
  const rates = ratesFor(price, promptTokens);
  if (cacheRead > 0 && rates.cacheReadPerMtok === undefined) return undefined;
  if (cacheWrite > 0 && rates.cacheWritePerMtok === undefined) return undefined;
  const freshInput = cachedInInput ? Math.max(0, inputTokens - cacheRead) : inputTokens;
  const total =
    freshInput * rates.inputPerMtok +
    outputTokens * rates.outputPerMtok +
    cacheRead * (rates.cacheReadPerMtok ?? 0) +
    cacheWrite * (rates.cacheWritePerMtok ?? 0);
  return total / MTOK;
}

/**
 * Prices `tokens` of `model` with `table`. `undefined` is the answer for "unknown": the model has
 * no price in the table, or the tokens are not enough to price (see {@link costOfTokens}).
 */
export function priceTokens(
  table: PricingTable,
  model: string | undefined,
  tokens: TokenCounts,
): PricedTokens | undefined {
  const found = findPrice(table, model);
  if (found === undefined) return undefined;
  const usd = costOfTokens(found.entry.price, tokens);
  if (usd === undefined) return undefined;
  return { usd, pricingVersion: pricingVersionOf(table, found.entry), model: found.model };
}
