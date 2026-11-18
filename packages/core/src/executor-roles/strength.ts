// SPDX-License-Identifier: MPL-2.0
import { EFFORT_LEVELS } from './names.js';

/**
 * The strength of a model and of an effort, for the step up of the cross-review that cannot leave
 * the provider of the work (`selection.same_provider_fallback`, Phase 5, P15b; architecture 5.7).
 * Nothing orders the models of the world, and nobody deduces it from a price or from an outside
 * source, so the order is declared: a tier per model, optional, one scale for every provider
 * (`models.<model>.tier` in the configuration; decided by the owner on 2026-11-18, N150). Built-in
 * defaults exist only for the ladders the provider itself publishes. "Stronger" holds only inside
 * one provider, with a tier declared on both sides and the tier of the candidate above the one of
 * the work; the same tier is not stronger, and a model with no tier never wins a comparison.
 */

/** The tiers, from the weakest to the strongest. */
export const MODEL_TIERS = ['small', 'medium', 'large', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * The built-in tiers, by provider and then by a word of the model name (a model name is split at
 * `-`, `.` and `_`: `claude-opus` has the word `opus`, `claude-opus-5-5` too). Claude: haiku =
 * small, sonnet = large, opus = frontier; OpenAI: luna = small, sol = frontier. The names of the
 * default tiers are [proposta]. A provider that is not here (minimax, gemma, deepseek, grok...) has
 * no tier until the Producer declares one.
 */
export const BUILTIN_MODEL_TIERS: Readonly<Record<string, Readonly<Record<string, ModelTier>>>> = {
  anthropic: { haiku: 'small', sonnet: 'large', opus: 'frontier' },
  openai: { luna: 'small', sol: 'frontier' },
};

/** An own entry of a table, so a model called `constructor` finds nothing. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The words of a model name, lower case. */
function wordsOf(model: string): string[] {
  return model
    .toLowerCase()
    .split(/[-._]+/)
    .filter((word) => word !== '');
}

/**
 * The tier of a model, or null when nothing says. The order of the look-up: the configuration by
 * the whole model name, the configuration by a word of it (`opus: frontier` covers
 * `claude-opus-5-5`) [proposta], then the built-in table of the provider by a word. The keys of
 * `overrides` are lower case.
 */
export function modelTier(
  model: string,
  provider: string,
  overrides: Readonly<Record<string, ModelTier>> = {},
): ModelTier | null {
  const whole = own(overrides, model.toLowerCase());
  if (whole !== undefined) return whole;
  const words = wordsOf(model);
  for (const word of words) {
    const tier = own(overrides, word);
    if (tier !== undefined) return tier;
  }
  const key = provider.toLowerCase();
  if (!Object.hasOwn(BUILTIN_MODEL_TIERS, key)) return null;
  const builtin = BUILTIN_MODEL_TIERS[key];
  if (builtin === undefined) return null;
  for (const word of words) {
    const tier = own(builtin, word);
    if (tier !== undefined) return tier;
  }
  return null;
}

/**
 * Whether the candidate is a stronger model than the one of the work: the same provider, a tier
 * declared on both sides, and the tier of the candidate above. Without a tier on one side, or with
 * the same tier, it is not.
 */
export function strongerModel(
  candidate: { readonly model: string; readonly provider: string },
  worked: { readonly model: string; readonly provider: string },
  overrides: Readonly<Record<string, ModelTier>> = {},
): boolean {
  if (candidate.provider.toLowerCase() !== worked.provider.toLowerCase()) return false;
  const mine = modelTier(candidate.model, candidate.provider, overrides);
  const theirs = modelTier(worked.model, worked.provider, overrides);
  if (mine === null || theirs === null) return false;
  return MODEL_TIERS.indexOf(mine) > MODEL_TIERS.indexOf(theirs);
}

/**
 * The level of an effort: the position in `EFFORT_LEVELS` (`low` < `medium` < `high`), or null for
 * no effort or one the list does not know.
 */
export function effortStrength(effort: string | null | undefined): number | null {
  if (effort === null || effort === undefined) return null;
  const index = (EFFORT_LEVELS as readonly string[]).indexOf(effort);
  return index === -1 ? null : index;
}
