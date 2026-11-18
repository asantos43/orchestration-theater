// SPDX-License-Identifier: MPL-2.0
import type { RoleId } from '../registries/roles.js';

/**
 * The role presets and the minimums of a role (architecture 5.7). The table is the one of 5.7, in
 * `<model>-<effort>` with no account: the expansion over the accounts that exist is
 * `expandPreset`. Marked [proposta] in 5.7: the `balanced` and `economical` rows after the first
 * item, the Consultant of `balanced` and `economical`, and the minimums (until the Phase 0
 * measurement).
 */

export const ROLE_PRESET_NAMES = ['quality', 'balanced', 'economical'] as const;
export type RolePresetName = (typeof ROLE_PRESET_NAMES)[number];

/** What a role does when no Executor of its list is available (5.7). */
export const WHEN_EXHAUSTED_MODES = ['next', 'wait'] as const;
export type WhenExhausted = (typeof WHEN_EXHAUSTED_MODES)[number];

/** The preset `roles.preset` takes when nothing says otherwise (5.7). */
export const DEFAULT_ROLE_PRESET: RolePresetName = 'quality';

export interface PresetRole {
  /** `<model>-<effort>` names, in order. */
  readonly heads: readonly string[];
  readonly whenExhausted: WhenExhausted;
}

const DIRECTOR = ['claude-haiku-low', 'codex-luna-low', 'gemma4-low'] as const;

function role(heads: readonly string[], whenExhausted: WhenExhausted = 'next'): PresetRole {
  return { heads, whenExhausted };
}

const QUALITY_AUTHOR = ['claude-opus-high', 'codex-sol-high'] as const;
const BALANCED_AUTHOR = ['claude-sonnet-high', 'codex-sol-medium'] as const;
const ECONOMICAL_AUTHOR = ['claude-sonnet-medium', 'codex-sol-medium'] as const;

/**
 * The table of 5.7. The Scriptwriter equals the Author. The `when_exhausted` of the roles the table
 * does not mark is `next` [proposta]; the Critic is `wait` and the Actors `next`, as 5.7 writes.
 */
export const ROLE_PRESETS: Readonly<Record<RolePresetName, Readonly<Record<RoleId, PresetRole>>>> =
  {
    quality: {
      director: role(DIRECTOR),
      consultant: role(QUALITY_AUTHOR),
      author: role(QUALITY_AUTHOR),
      reviewer: role(['codex-sol-high', 'claude-opus-high']),
      scriptwriter: role(QUALITY_AUTHOR),
      critic: role(['claude-opus-high', 'codex-sol-high'], 'wait'),
      actor: role(['codex-sol-high', 'claude-sonnet-medium', 'minimax-m2-medium']),
    },
    balanced: {
      director: role(DIRECTOR),
      consultant: role(QUALITY_AUTHOR),
      author: role(BALANCED_AUTHOR),
      reviewer: role(['codex-sol-medium', 'claude-sonnet-high']),
      scriptwriter: role(BALANCED_AUTHOR),
      critic: role(['claude-opus-high', 'codex-sol-high'], 'wait'),
      actor: role(['claude-sonnet-medium', 'codex-sol-medium', 'minimax-m2-medium']),
    },
    economical: {
      director: role(DIRECTOR),
      consultant: role(BALANCED_AUTHOR),
      author: role(ECONOMICAL_AUTHOR),
      reviewer: role(['codex-sol-medium', 'claude-sonnet-medium']),
      scriptwriter: role(ECONOMICAL_AUTHOR),
      critic: role(['claude-sonnet-high', 'codex-sol-medium'], 'wait'),
      actor: role(['minimax-m2-medium', 'gemma4-medium', 'claude-sonnet-medium']),
    },
  };

/** What a role asks of a model (5.7, "Capacidade mínima por papel"): `context` in tokens. */
export interface RoleRequires {
  readonly context?: number | undefined;
  readonly reasoning?: boolean | undefined;
}

/** The minimums of 5.7, in tokens: 32k, 64k and 128k. [proposta] until the measurement. */
export const DEFAULT_ROLE_REQUIRES: Readonly<Record<RoleId, RoleRequires>> = {
  director: { context: 32_000 },
  consultant: { context: 128_000, reasoning: true },
  author: { context: 128_000, reasoning: true },
  reviewer: { context: 128_000, reasoning: true },
  scriptwriter: { context: 128_000, reasoning: true },
  critic: { context: 128_000, reasoning: true },
  actor: { context: 64_000 },
};

/**
 * `32k`, `128k`, `1m` or a plain number of tokens, in tokens. `k` is 1000 and `m` is 1000000
 * [proposta]: a "128k" model that reports 128000 passes. `undefined` when the text is not a size.
 */
export function parseContextSize(text: string | number): number | undefined {
  if (typeof text === 'number') return Number.isInteger(text) && text > 0 ? text : undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim());
  if (match === null) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(match[1]) * factor);
  return value > 0 ? value : undefined;
}
