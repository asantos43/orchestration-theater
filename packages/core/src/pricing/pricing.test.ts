// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_MODEL_PRICES,
  BUILT_IN_PRICING_VERSION,
  builtInPricing,
  costOfTokens,
  findPrice,
  mergePricing,
  normalizeModelId,
  priceTokens,
} from './index.js';

describe('built-in pricing table', () => {
  it('has a source URL and the consultation date on every entry (N125)', () => {
    for (const [model, price] of Object.entries(BUILT_IN_MODEL_PRICES)) {
      expect(price.source?.url, model).toMatch(/^https:\/\//);
      expect(price.source?.consultedOn, model).toBe('2026-11-18');
    }
  });

  it('keeps out the models of the quality preset that have no reliable price', () => {
    const table = builtInPricing();
    expect(table.models.has('minimax-m2')).toBe(false);
    expect(table.models.has('gemma4')).toBe(false);
    expect([...table.models.keys()].sort()).toEqual([
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-6-luna',
      'gpt-6-sol',
    ]);
    expect(table.version).toBe(BUILT_IN_PRICING_VERSION);
  });
});

describe('normalizeModelId', () => {
  it('drops the provider prefix, the bracket suffix and the date, and turns dots into dashes', () => {
    expect(normalizeModelId('Anthropic/Claude-Opus-5.5')).toBe('claude-opus-5-5');
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModelId('claude-sonnet-5-5-20261101')).toBe('claude-sonnet-5-5');
    expect(normalizeModelId(' openai/gpt-6-sol ')).toBe('gpt-6-sol');
  });

  it('finds a price by any of those spellings and no price for a similar name', () => {
    const table = builtInPricing();
    expect(findPrice(table, 'claude-opus-5.5')?.model).toBe('claude-opus-5-5');
    expect(findPrice(table, 'gpt-6-sol-mini')).toBeUndefined();
    expect(findPrice(table, 'opus')).toBeUndefined();
    expect(findPrice(table, undefined)).toBeUndefined();
  });
});

describe('costOfTokens', () => {
  const opus = BUILT_IN_MODEL_PRICES['claude-opus-5-5']!;
  const haiku = BUILT_IN_MODEL_PRICES['claude-haiku-5-5']!;
  const sol = BUILT_IN_MODEL_PRICES['gpt-6-sol']!;

  it('is tokens times the price per million', () => {
    // 1M input at US$ 4 + 100k output at US$ 20 = 4 + 2
    expect(costOfTokens(opus, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(
      6,
      10,
    );
  });

  it('bills the Claude cache tokens apart from the input', () => {
    // 100k fresh input (0.4) + 1M cache read (0.2) + 200k cache write (1.0) + 10k output (0.2)
    expect(
      costOfTokens(opus, {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 200_000,
      }),
    ).toBeCloseTo(1.8, 10);
  });

  it('takes the OpenAI cached tokens off the input (they are counted inside it)', () => {
    // input 1M of which 800k cached: 200k fresh (0.4) + 800k cached (0.16) + 50k output (0.5)
    expect(
      costOfTokens(sol, { inputTokens: 1_000_000, outputTokens: 50_000, cacheReadTokens: 800_000 }),
    ).toBeCloseTo(1.06, 10);
  });

  it('switches to the long-context card when the prompt is above the threshold', () => {
    expect(costOfTokens(haiku, { inputTokens: 100_000, outputTokens: 1_000_000 })).toBeCloseTo(
      0.01 + 0.5,
      10,
    );
    expect(costOfTokens(haiku, { inputTokens: 100_001, outputTokens: 1_000_000 })).toBeCloseTo(
      (100_001 * 0.5) / 1e6 + 2.5,
      10,
    );
    // the cache read counts toward the size of the prompt
    expect(
      costOfTokens(haiku, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 150_000 }),
    ).toBeCloseTo((1000 * 0.5 + 150_000 * 0.05) / 1e6, 10);
  });

  it('is unknown, never zero, when the tokens or the cache price are missing', () => {
    expect(costOfTokens(opus, { inputTokens: 10 })).toBeUndefined();
    expect(costOfTokens(opus, { outputTokens: 10 })).toBeUndefined();
    expect(costOfTokens(opus, {})).toBeUndefined();
    const noCache = { inputPerMtok: 1, outputPerMtok: 2 };
    expect(
      costOfTokens(noCache, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 5 }),
    ).toBeUndefined();
    expect(costOfTokens(noCache, { inputTokens: 1, outputTokens: 1 })).toBeCloseTo(3e-6, 12);
  });

  it('prices a real zero as zero: a turn with no tokens at all costs US$ 0', () => {
    expect(costOfTokens(opus, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe('priceTokens and mergePricing', () => {
  it('has no price for a model the table does not know (unknown, not US$ 0)', () => {
    expect(
      priceTokens(builtInPricing(), 'minimax-m2', { inputTokens: 10, outputTokens: 10 }),
    ).toBeUndefined();
  });

  it('records the built-in version, and marks an entry the config wrote', () => {
    const base = builtInPricing();
    expect(
      priceTokens(base, 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toMatchObject({ usd: 2, pricingVersion: '2026-11-18' });
    const table = mergePricing(base, {
      'MiniMax-M2': { inputPerMtok: 0.3, outputPerMtok: 1.2 },
      'claude-sonnet-5-5': { inputPerMtok: 1, outputPerMtok: 5 },
    });
    expect(
      priceTokens(table, 'minimax-m2', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toMatchObject({ usd: 1.5, pricingVersion: '2026-11-18+config' });
    expect(
      priceTokens(table, 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toMatchObject({ usd: 1, pricingVersion: '2026-11-18+config' });
    // the entries nobody touched keep the built-in version, and the base table is not changed
    expect(
      priceTokens(table, 'claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toMatchObject({ usd: 4, pricingVersion: '2026-11-18' });
    expect(base.models.has('minimax-m2')).toBe(false);
  });
});
