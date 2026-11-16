// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Schemas of the configuration keys of the Executor layer (architecture 5.2, 5.9 and 5.16). Each
 * block is validated at start-up by the module that owns the key (5.18); defaults here are the
 * ones the architecture states, and every default it does not state is marked [proposta].
 *
 * Not here: `timeouts`. The architecture names no such block (only "timeouts" inside the
 * `limits` preset of 5.4), so no schema was invented for it.
 */

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Milliseconds of a duration written as text (`30m`, `2h`, `45s`, `1d`, `500ms`); `undefined` if malformed. */
export function parseDurationText(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const [, amount, unit] = match;
  if (amount === undefined || unit === undefined) return undefined;
  const ms = Number(amount) * DURATION_UNIT_MS[unit as keyof typeof DURATION_UNIT_MS];
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** A duration written as text in the configuration; the parsed value is milliseconds. */
export const DurationTextSchema = z.string().transform((text, ctx) => {
  const ms = parseDurationText(text);
  if (ms === undefined) {
    ctx.addIssue({ code: 'custom', message: 'expected a duration such as 30m, 2h, 45s or 500ms' });
    return z.NEVER;
  }
  return ms;
});

/** Same, but zero is refused: for intervals and timeouts that must be positive. */
const PositiveDurationTextSchema = DurationTextSchema.refine((ms) => ms > 0, {
  message: 'expected a duration greater than zero',
});

// ---- `local` block of a profile (5.9) ------------------------------------------------------

export const LOCAL_SERVERS = ['llama-cpp', 'ollama'] as const;
export const RESERVE_WHEN_VALUES = ['listed', 'always', 'never'] as const;

/**
 * `profiles.<client>/<profile>.local` (architecture 5.9): the local model server behind a profile.
 *
 * - `server` picks the `LocalModelServer` adapter. [proposta] default `llama-cpp` (the v1 adapter).
 * - `url` is required: the architecture gives no default address.
 * - `slots: auto` reads the number from the instance; without a reading, 1 (5.9).
 * - `reserve_for_director`: slots kept for the Director; `all` keeps the whole instance. Default 1.
 * - `reserve_when`: `listed` (only if the profile is in the Director's list), `always`, `never`.
 *   Default `listed`. Both defaults are [proposta] in the architecture.
 */
export const LocalConfigSchema = z
  .strictObject({
    server: z.enum(LOCAL_SERVERS).default('llama-cpp'),
    url: z.url({ protocol: /^https?$/ }),
    slots: z.union([z.literal('auto'), z.int().min(1)]).default('auto'),
    reserve_for_director: z.union([z.int().min(0), z.literal('all')]).default(1),
    reserve_when: z.enum(RESERVE_WHEN_VALUES).default('listed'),
  })
  .refine(
    (c) =>
      typeof c.slots !== 'number' ||
      typeof c.reserve_for_director !== 'number' ||
      c.reserve_for_director <= c.slots,
    {
      path: ['reserve_for_director'],
      message: 'cannot reserve more slots than the instance has (use "all" to reserve it whole)',
    },
  );
export type LocalConfig = z.output<typeof LocalConfigSchema>;

// ---- `pool` per client (5.2) ----------------------------------------------------------------

/** OpenCode process model (decided 2026-11-16, N56). */
export const OPENCODE_PROCESS_MODELS = ['per_profile', 'per_session'] as const;

/**
 * Pool of one client: up to `k` sessions per adapter process, and an idle process is ended after
 * `idle_ms` (architecture 5.2, "Pools"). [proposta] defaults: `k` 3 (the Phase 0 measurement
 * used 3 sessions), `idle_ms` 300000 (5 minutes); the architecture gives no numbers.
 */
const poolFields = {
  k: z.int().min(1).default(3),
  idle_ms: z.int().min(0).default(300_000),
};

export const ClientPoolConfigSchema = z.strictObject(poolFields);
export type ClientPoolConfig = z.output<typeof ClientPoolConfigSchema>;

/** The OpenCode pool adds `process_model`, default `per_profile` (N56). */
export const OpenCodePoolConfigSchema = z.strictObject({
  ...poolFields,
  process_model: z.enum(OPENCODE_PROCESS_MODELS).default('per_profile'),
});
export type OpenCodePoolConfig = z.output<typeof OpenCodePoolConfigSchema>;

/** `pool`: one block per client; a client with no block takes the defaults. */
export const PoolConfigSchema = z.strictObject({
  'claude-code': ClientPoolConfigSchema.prefault({}),
  codex: ClientPoolConfigSchema.prefault({}),
  opencode: OpenCodePoolConfigSchema.prefault({}),
  gemini: ClientPoolConfigSchema.prefault({}),
});
export type PoolConfig = z.output<typeof PoolConfigSchema>;

// ---- `resume` (5.16) -------------------------------------------------------------------------

export const RESUME_PRESET_NAMES = ['balanced', 'patient', 'agile'] as const;
export type ResumePresetName = (typeof RESUME_PRESET_NAMES)[number];

/** Values of a resolved `resume` block; durations in milliseconds. */
export interface ResumeSettings {
  readonly max_resumes: number;
  /** Resumes of a session lost to another session's cancel that do not count in `max_resumes`. */
  readonly max_free_resumes: number;
  readonly quota_wait_max: number;
  readonly checkpoint_every: number;
  readonly stuck: { readonly no_event_for: number; readonly same_error_times: number };
}

/** The three presets of the table in architecture 5.16 (decided 2026-11-14, N14). */
export const RESUME_PRESETS: Readonly<Record<ResumePresetName, ResumeSettings>> = {
  balanced: {
    max_resumes: 5,
    max_free_resumes: 3,
    quota_wait_max: 30 * 60_000,
    checkpoint_every: 10 * 60_000,
    stuck: { no_event_for: 10 * 60_000, same_error_times: 3 },
  },
  patient: {
    max_resumes: 8,
    max_free_resumes: 3,
    quota_wait_max: 2 * 3_600_000,
    checkpoint_every: 15 * 60_000,
    stuck: { no_event_for: 20 * 60_000, same_error_times: 5 },
  },
  agile: {
    max_resumes: 3,
    max_free_resumes: 3,
    quota_wait_max: 10 * 60_000,
    checkpoint_every: 5 * 60_000,
    stuck: { no_event_for: 5 * 60_000, same_error_times: 2 },
  },
};

/** `transient_backoff` does not change with the preset [proposta]: 30 s, 2 min, 10 min. */
export const DEFAULT_TRANSIENT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

/**
 * `resume` (architecture 5.16): the `preset` fills every value at once and an individual key
 * overrides just its own value [proposta]. Parsing returns the resolved settings, durations as
 * milliseconds, plus the preset that was named.
 */
export const ResumeConfigSchema = z
  .strictObject({
    preset: z.enum(RESUME_PRESET_NAMES).default('balanced'),
    max_resumes: z.int().min(0).optional(),
    max_free_resumes: z.int().min(0).optional(),
    quota_wait_max: DurationTextSchema.optional(),
    checkpoint_every: PositiveDurationTextSchema.optional(),
    stuck: z
      .strictObject({
        no_event_for: PositiveDurationTextSchema.optional(),
        same_error_times: z.int().min(1).optional(),
      })
      .optional(),
    transient_backoff: z.array(PositiveDurationTextSchema).min(1).optional(),
  })
  .transform((c) => {
    const base = RESUME_PRESETS[c.preset];
    return {
      preset: c.preset,
      max_resumes: c.max_resumes ?? base.max_resumes,
      max_free_resumes: c.max_free_resumes ?? base.max_free_resumes,
      quota_wait_max: c.quota_wait_max ?? base.quota_wait_max,
      checkpoint_every: c.checkpoint_every ?? base.checkpoint_every,
      stuck: {
        no_event_for: c.stuck?.no_event_for ?? base.stuck.no_event_for,
        same_error_times: c.stuck?.same_error_times ?? base.stuck.same_error_times,
      },
      transient_backoff: c.transient_backoff ?? [...DEFAULT_TRANSIENT_BACKOFF_MS],
    };
  });
export type ResumeConfig = z.output<typeof ResumeConfigSchema>;
