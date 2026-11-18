// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODEL_TIERS,
  MODEL_TIERS,
  effortStrength,
  modelTier,
  strongerModel,
} from './strength.js';

describe('the tiers of the models (N150)', () => {
  it('has one scale for every provider, from small to frontier', () => {
    expect(MODEL_TIERS).toEqual(['small', 'medium', 'large', 'frontier']);
  });

  it('has built-in tiers only for the ladders the provider publishes', () => {
    expect(Object.keys(BUILTIN_MODEL_TIERS).sort()).toEqual(['anthropic', 'openai']);
    expect(modelTier('claude-haiku', 'anthropic')).toBe('small');
    expect(modelTier('claude-sonnet', 'anthropic')).toBe('large');
    expect(modelTier('claude-opus', 'anthropic')).toBe('frontier');
    expect(modelTier('claude-opus-5-5', 'anthropic')).toBe('frontier');
    expect(modelTier('luna', 'openai')).toBe('small');
    expect(modelTier('codex-sol', 'openai')).toBe('frontier');
  });

  it('leaves every other provider without a tier', () => {
    for (const [model, provider] of [
      ['minimax-m3', 'minimax'],
      ['gemma4', 'google'],
      ['deepseek-v4', 'deepseek'],
      ['grok-5', 'xai'],
      ['opus', 'unknown'],
    ] as const) {
      expect(modelTier(model, provider)).toBeNull();
    }
  });

  it('takes a tier from the configuration by the whole name or by a word, before the built-in', () => {
    expect(modelTier('Minimax-M3', 'minimax', { 'minimax-m3': 'large' })).toBe('large');
    expect(modelTier('claude-opus-5-5', 'anthropic', { opus: 'large' })).toBe('large');
    expect(modelTier('claude-opus', 'anthropic', { 'claude-opus': 'medium', opus: 'large' })).toBe(
      'medium',
    );
  });

  it('does not read a prototype property as a tier', () => {
    expect(modelTier('constructor', 'anthropic')).toBeNull();
    expect(modelTier('constructor', 'constructor')).toBeNull();
    expect(modelTier('toString', 'openai', {})).toBeNull();
  });

  describe('strongerModel', () => {
    const sonnet = { model: 'claude-sonnet', provider: 'anthropic' };
    const opus = { model: 'claude-opus', provider: 'anthropic' };
    const haiku = { model: 'claude-haiku', provider: 'anthropic' };

    it('is a higher tier of the same provider', () => {
      expect(strongerModel(opus, sonnet)).toBe(true);
      expect(strongerModel(sonnet, opus)).toBe(false);
      expect(strongerModel(haiku, sonnet)).toBe(false);
    });

    it('is not the same tier, nor the same model', () => {
      expect(strongerModel(sonnet, sonnet)).toBe(false);
      expect(strongerModel(opus, { model: 'claude-opus-5', provider: 'anthropic' })).toBe(false);
    });

    it('needs a tier on both sides', () => {
      const m2 = { model: 'minimax-m2', provider: 'minimax' };
      const m3 = { model: 'minimax-m3', provider: 'minimax' };
      expect(strongerModel(m3, m2)).toBe(false);
      expect(strongerModel(m3, m2, { 'minimax-m3': 'frontier' })).toBe(false);
      expect(strongerModel(m3, m2, { 'minimax-m2': 'small' })).toBe(false);
      expect(strongerModel(m3, m2, { 'minimax-m2': 'small', 'minimax-m3': 'medium' })).toBe(true);
    });

    it('holds only inside one provider', () => {
      expect(strongerModel({ model: 'codex-sol', provider: 'openai' }, sonnet)).toBe(false);
      expect(
        strongerModel(
          { model: 'x', provider: 'openai' },
          { model: 'y', provider: 'anthropic' },
          { x: 'frontier', y: 'small' },
        ),
      ).toBe(false);
    });
  });

  it('orders the efforts as the names do, and knows no other', () => {
    expect(effortStrength('low')).toBeLessThan(effortStrength('medium') ?? -1);
    expect(effortStrength('medium')).toBeLessThan(effortStrength('high') ?? -1);
    expect(effortStrength('turbo')).toBeNull();
    expect(effortStrength(null)).toBeNull();
    expect(effortStrength(undefined)).toBeNull();
  });
});
