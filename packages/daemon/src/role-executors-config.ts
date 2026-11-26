// SPDX-License-Identifier: MPL-2.0
import {
  API_FALLBACK_MODES,
  CAPABILITY_CHECK_MODES,
  CROSS_CHECK_MODES,
  CROSS_CLIENT_MODES,
  EFFORT_LEVELS,
  FIXED_PROVIDER_OF_CLIENT,
  MODEL_TIERS,
  NEAR_LIMIT_MODES,
  ON_REGISTER_MODES,
  PRESET_SCOPES,
  PROFILE_NAME_PATTERN,
  RETRY_DIVERSITY_MODES,
  ROLE_PRESET_NAMES,
  SAME_PROVIDER_ACCOUNT_MODES,
  SAME_PROVIDER_FALLBACK_MODES,
  SELECTION_STRATEGIES,
  STRICT_UNAVAILABLE_MODES,
  UNKNOWN_QUOTA_MODES,
  WHEN_EXHAUSTED_MODES,
  parseContextSize,
  parseProfileId,
  providerOfClient,
  tryParseExecutorId,
  type CrossClientMode,
  type ExecutorEntry,
  type OnRegisterMode,
} from '@otheater/core';
import { parseDurationText } from '@otheater/protocol';
import { z } from 'zod';
import { ExecutorBudgetSchema, type ExecutorBudgetConfig } from './budget-config.js';

/**
 * The Executors and the lists of the roles in the configuration (architecture 5.7; Phase 5, P13):
 * `executors.<id>`, `executors.cross_client`, `executors.on_register` and, under `roles`,
 * `preset`, `capability_check`, `allowed_profiles`, `roles.<role>.executors`, `.when_exhausted`
 * and `.requires`. The key names of `preset_scope` and `api_fallback`, and the spelling of
 * `requires.context` (`32k`), are [proposta]; the architecture fixes the rest.
 *
 * Every error names its key (`roles.author.executors.1: ...`): `describeZodError` prefixes the
 * path of the block. Since P16 the pipeline reads these lists through the selector; a role with no
 * list falls back to `orchestration.executor` and `orchestration.roles.<role>` (the old format).
 */

/**
 * `executors.test_session` (P14, [proposta]): whether the cadastro runs the short test session of
 * 5.7 (the model calls a tool and delivers a valid `submit`). `off` (default): no session is run,
 * the validation of the catalog alone decides; `run`: the session runs (a call to the model, so it
 * may spend quota) and its outcome is read per `roles.capability_check`.
 */
export const TEST_SESSION_MODES = ['off', 'run'] as const;
export type TestSessionMode = (typeof TEST_SESSION_MODES)[number];

const oneOf = (key: string, values: readonly string[]) => ({
  error: (issue: { input?: unknown }) =>
    `${key}: ${JSON.stringify(issue.input)} is not accepted; use ${values.map((v) => `"${v}"`).join(', ')}`,
});

/** An Executor name as a role list writes it (`claude-opus-high@claude-code/empresa`). */
export const ExecutorIdSchema = z.string().superRefine((id, ctx) => {
  const parsed = tryParseExecutorId(id);
  if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: parsed });
});

/** A `roles.<role>.executors` list: at least one Executor, each once. */
export const RoleExecutorListSchema = z
  .array(ExecutorIdSchema)
  .min(1, { message: 'the list is empty; name at least one Executor, or leave the key out' })
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `${JSON.stringify(id)} appears twice in the list`,
        });
      }
      seen.add(id);
    });
  });

/** `roles.allowed_profiles`: `<client>/<profile>`, each once. */
export const AllowedProfilesSchema = z
  .array(
    z.string().superRefine((id, ctx) => {
      try {
        parseProfileId(id);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `${JSON.stringify(id)} is not a profile; expected <client>/<profile>`,
        });
      }
    }),
  )
  .min(1, { message: 'the list is empty; it would leave every role with no account' })
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `profile ${JSON.stringify(id)} appears twice`,
        });
      }
      seen.add(id);
    });
  });

/** `requires.context`: `32k`, `128k`, `1m` or a number of tokens; parsed to tokens. */
const ContextSchema = z
  .union([z.string(), z.number()], {
    error: 'context: a size such as "32k", "128k" or a number of tokens',
  })
  .transform((value, ctx) => {
    const tokens = parseContextSize(value);
    if (tokens === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(value)} is not a size; use "32k", "128k" or a number of tokens`,
      });
      return z.NEVER;
    }
    return tokens;
  });

/** `roles.<role>.requires` (5.7): the minimum the role asks of a model. */
export const RoleRequiresSchema = z.strictObject({
  context: ContextSchema.optional(),
  reasoning: z.boolean().optional(),
});

/** What `roles.<role>` takes besides the policy. */
export const roleExecutorKeys = {
  executors: RoleExecutorListSchema.optional(),
  when_exhausted: z
    .enum(WHEN_EXHAUSTED_MODES, oneOf('when_exhausted', WHEN_EXHAUSTED_MODES))
    .optional(),
  requires: RoleRequiresSchema.optional(),
};

/** What `roles` takes besides the roles themselves. */
export const rolesBlockKeys = {
  preset: z.enum(ROLE_PRESET_NAMES, oneOf('preset', ROLE_PRESET_NAMES)).optional(),
  capability_check: z
    .enum(CAPABILITY_CHECK_MODES, oneOf('capability_check', CAPABILITY_CHECK_MODES))
    .optional(),
  allowed_profiles: AllowedProfilesSchema.optional(),
  preset_scope: z.enum(PRESET_SCOPES, oneOf('preset_scope', PRESET_SCOPES)).optional(),
  api_fallback: z.enum(API_FALLBACK_MODES, oneOf('api_fallback', API_FALLBACK_MODES)).optional(),
};

/** `executors.aliases`: a model name of a preset (`codex-sol`) to the id a catalog lists. */
const AliasesSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, {
    message: 'a model name of a preset, such as "codex-sol"',
  }),
  z.string().min(1, { message: 'the model id the catalog lists, such as "gpt-6.2-sol"' }),
);

/** One `executors.<id>` as written. */
const ExecutorEntryInputSchema = z.strictObject({
  client: z
    .string()
    .regex(PROFILE_NAME_PATTERN, { message: 'client: a client id such as "claude-code"' }),
  profile: z.string().regex(PROFILE_NAME_PATTERN, { message: 'profile: a profile name' }),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS, oneOf('effort', EFFORT_LEVELS)).optional(),
  provider: z.string().min(1).optional(),
  /**
   * N136: `false` keeps the Executor out of the expansion of a preset; it is then only in the
   * roles that name it. Default `true`. `ot executor add` writes `false` under
   * `executors.on_register: none`.
   */
  preset_expand: z.boolean().optional(),
  /** The spending cap of this Executor, inside its profile's (5.6; P11). */
  budget: ExecutorBudgetSchema.optional(),
});

/** The `executors` block, after parsing: the two modes and the registered Executors. */
export interface ExecutorsConfig {
  readonly cross_client: CrossClientMode;
  readonly on_register: OnRegisterMode;
  readonly test_session: TestSessionMode;
  /**
   * `executors.aliases` (N333, 2026-11-26): the model a name of a preset (`codex-sol`) stands for,
   * as the catalog of the client lists it (`gpt-6.2-sol`). The setup assistant reads it before the
   * rule of `setup.preset_match`. Empty by default.
   */
  readonly aliases: Readonly<Record<string, string>>;
  /** The `executors.<id>` entries by id, with the provider settled (5.7). */
  readonly entries: Readonly<Record<string, ExecutorEntry>>;
  /** The `executors.<id>.budget` of the Executors that have one, by Executor name (P11). */
  readonly budgets: Readonly<Record<string, ExecutorBudgetConfig>>;
}

/**
 * `executors`: the two modes and, as every other key, an Executor named
 * `<model>-<effort>@<client>/<profile>` (5.7). The name must agree with the `client`, `profile`
 * and `effort` it carries, and the `provider` of Claude Code and Codex is fixed by the client.
 * A key that is neither a mode nor a well formed name is refused with its name.
 */
export const ExecutorsConfigSchema = z
  .record(z.string(), z.unknown())
  .transform((raw, ctx): ExecutorsConfig => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    let cross_client: CrossClientMode = 'api_only';
    let on_register: OnRegisterMode = 'ask';
    let test_session: TestSessionMode = 'off';
    let aliases: Record<string, string> = {};
    const entries: Record<string, ExecutorEntry> = {};
    const budgets: Record<string, ExecutorBudgetConfig> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (key === 'cross_client') {
        const parsed = z.enum(CROSS_CLIENT_MODES, oneOf(key, CROSS_CLIENT_MODES)).safeParse(value);
        if (parsed.success) cross_client = parsed.data;
        else issue([key], parsed.error.issues[0]?.message ?? 'not accepted');
        continue;
      }
      if (key === 'on_register') {
        const parsed = z.enum(ON_REGISTER_MODES, oneOf(key, ON_REGISTER_MODES)).safeParse(value);
        if (parsed.success) on_register = parsed.data;
        else issue([key], parsed.error.issues[0]?.message ?? 'not accepted');
        continue;
      }
      if (key === 'test_session') {
        const parsed = z.enum(TEST_SESSION_MODES, oneOf(key, TEST_SESSION_MODES)).safeParse(value);
        if (parsed.success) test_session = parsed.data;
        else issue([key], parsed.error.issues[0]?.message ?? 'not accepted');
        continue;
      }
      if (key === 'aliases') {
        const parsed = AliasesSchema.safeParse(value);
        if (parsed.success) aliases = parsed.data;
        else
          for (const inner of parsed.error.issues)
            issue([key, ...inner.path.map(String)], inner.message);
        continue;
      }
      const name = tryParseExecutorId(key);
      if (typeof name === 'string') {
        issue(
          [key],
          `${name}; the keys of executors are "cross_client", "on_register", "test_session", "aliases" and Executor names`,
        );
        continue;
      }
      const parsed = ExecutorEntryInputSchema.safeParse(value);
      if (!parsed.success) {
        for (const inner of parsed.error.issues)
          issue([key, ...inner.path.map(String)], inner.message);
        continue;
      }
      const entry = parsed.data;
      if (entry.client !== name.client || entry.profile !== name.profile) {
        issue(
          [key],
          `the name says ${name.profileId} but client/profile say ${entry.client}/${entry.profile}`,
        );
        continue;
      }
      const effort = entry.effort ?? null;
      if (effort !== name.effort) {
        issue(
          [key, 'effort'],
          `the name says effort ${name.effort ?? '(none)'} but effort is ${effort ?? '(none)'}`,
        );
        continue;
      }
      const fixed = FIXED_PROVIDER_OF_CLIENT[entry.client];
      if (fixed !== undefined && entry.provider !== undefined && entry.provider !== fixed) {
        issue(
          [key, 'provider'],
          `${JSON.stringify(entry.provider)} is refused: the provider of ${entry.client} is fixed by the client ("${fixed}")`,
        );
        continue;
      }
      entries[key] = {
        id: key,
        client: entry.client,
        profile: entry.profile,
        model: entry.model,
        effort,
        provider: providerOfClient(entry.client, entry.provider),
        ...(entry.preset_expand === undefined ? {} : { presetExpand: entry.preset_expand }),
      };
      if (entry.budget !== undefined) budgets[key] = entry.budget;
    }
    return { cross_client, on_register, test_session, aliases, entries, budgets };
  });

/** `selection.unregistered_profiles` (P16, [proposta]). */
export const UNREGISTERED_PROFILE_MODES = ['allow', 'refuse'] as const;
/** `selection.director_wait` (P16, [proposta]). */
export const DIRECTOR_WAIT_MODES = ['fail', 'wait'] as const;

/** `selection.recheck_every`: a duration (`30s`, `2m`) in milliseconds, or `off` (0: only the wake). */
const RecheckSchema = z
  .union([z.literal('off'), z.string()], {
    error: 'recheck_every: a duration such as "30s" or "2m", or "off"',
  })
  .transform((value, ctx) => {
    if (value === 'off') return 0;
    const ms = parseDurationText(value);
    if (ms === undefined || ms <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(value)} is not a duration; use "30s", "2m" or "off"`,
      });
      return z.NEVER;
    }
    return ms;
  });

/**
 * `selection` (architecture 5.7; Phase 5, P15): how the daemon picks among the Executors of a role.
 * `strategy` (N130) and `cross_check` are the architecture's; the defaults are its defaults.
 * [proposta] `unknown_quota` and `near_limit` are the keys N124 decided (`allow` and `keep_order`),
 * and `retry_diversity` and `context_reserve` are keys this passage adds so no default is hardcoded:
 * `retry_diversity` is how a retry starts after the Executor that failed (`rotate`: the 5.7 rule,
 * wrapping around), `context_reserve` the tokens the client keeps for its own prompt and tools,
 * which the prompt of a demand must leave free in the window (0 until measured).
 *
 * P16 adds three [proposta] keys, so the pipeline hardcodes no default: `unregistered_profiles`
 * (what a legacy `orchestration.executor` that names a profile the registry does not know does:
 * `allow` treats it as an active token plan, which is what the pipeline did until P16; `refuse` marks
 * it invalid), `recheck_every` (how often a demand with no Executor looks again on its own, besides
 * the wake of P9 on `quota.restored`; `off` leaves it to the wake) and `director_wait` (what the
 * Director's session does with no Executor: `fail` answers at once with the reason, `wait` holds
 * the opening until one is free and resumes by itself when the wake or the recheck finds one;
 * `wait` is the default since the owner's answer of 2026-11-18, N141).
 *
 * `waiting_holds_slot` (N142, 2026-11-18, [proposta] for the name): whether a demand that waits for
 * an Executor still counts as in flight in its play. `false` (default) takes it out of the in-flight
 * count while it waits, so other demands of the play advance; `true` keeps it counted, as P16 did.
 *
 * `strict_unavailable` (N135, decided by the owner on 2026-11-18) is what a strict `cross_check`
 * (`require_other_provider`, `other_model`) does when only the provider or the model of the work
 * is available: `wait_notify` (default) waits and flags the wait, `fallback_prefer` goes back to
 * the provider of the work as `prefer_other_provider` does, `wait` waits silently.
 *
 * `same_provider_fallback` (N150, decided by the owner on 2026-11-18) is what the Reviewer and the
 * Critic take when the cross-review cannot be met and the choice goes back to the provider of who
 * did the work: `stronger_then_effort` (default: a stronger model, then the same model with a higher
 * effort, then any), `stronger_model`, `higher_effort` or `any` (the list, as before).
 * `same_provider_account` (N150) says, inside each of those steps, whether the Executors of another
 * account than the one of the work come first (`prefer_other`, default) or the account has no
 * special treatment (`strategy`). The strength of the models for the "stronger" step is declared in `models.<model>.tier`
 * (`ModelsConfigSchema`).
 */
export const SelectionConfigSchema = z.strictObject({
  strategy: z
    .enum(SELECTION_STRATEGIES, oneOf('strategy', SELECTION_STRATEGIES))
    .default('ordered'),
  cross_check: z
    .enum(CROSS_CHECK_MODES, oneOf('cross_check', CROSS_CHECK_MODES))
    .default('prefer_other_provider'),
  unknown_quota: z
    .enum(UNKNOWN_QUOTA_MODES, oneOf('unknown_quota', UNKNOWN_QUOTA_MODES))
    .default('allow'),
  near_limit: z.enum(NEAR_LIMIT_MODES, oneOf('near_limit', NEAR_LIMIT_MODES)).default('keep_order'),
  retry_diversity: z
    .enum(RETRY_DIVERSITY_MODES, oneOf('retry_diversity', RETRY_DIVERSITY_MODES))
    .default('rotate'),
  context_reserve: ContextSchema.default(0),
  unregistered_profiles: z
    .enum(UNREGISTERED_PROFILE_MODES, oneOf('unregistered_profiles', UNREGISTERED_PROFILE_MODES))
    .default('allow'),
  recheck_every: RecheckSchema.default(30_000),
  director_wait: z
    .enum(DIRECTOR_WAIT_MODES, oneOf('director_wait', DIRECTOR_WAIT_MODES))
    .default('wait'),
  waiting_holds_slot: z.boolean({ error: 'waiting_holds_slot: true or false' }).default(false),
  strict_unavailable: z
    .enum(STRICT_UNAVAILABLE_MODES, oneOf('strict_unavailable', STRICT_UNAVAILABLE_MODES))
    .default('wait_notify'),
  same_provider_fallback: z
    .enum(
      SAME_PROVIDER_FALLBACK_MODES,
      oneOf('same_provider_fallback', SAME_PROVIDER_FALLBACK_MODES),
    )
    .default('stronger_then_effort'),
  same_provider_account: z
    .enum(SAME_PROVIDER_ACCOUNT_MODES, oneOf('same_provider_account', SAME_PROVIDER_ACCOUNT_MODES))
    .default('prefer_other'),
});
/**
 * `models.<model>.tier` (N150, decided by the owner on 2026-11-18): the tier of a model on the one
 * scale of every provider, `small` < `medium` < `large` < `frontier`, optional. The key is the name
 * of the model, or a word of it (`opus`) [proposta]. It replaces the built-in tiers (Claude: haiku
 * small, sonnet large, opus frontier; OpenAI: luna small, sol frontier); a model with no tier is
 * never "stronger" and the step of the stronger model is skipped. Nothing is deduced from a price.
 */
export const ModelsConfigSchema = z.record(
  z.string().min(1),
  z.strictObject({
    tier: z.enum(MODEL_TIERS, oneOf('tier', MODEL_TIERS)).optional(),
  }),
);
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type SelectionConfig = z.infer<typeof SelectionConfigSchema>;
