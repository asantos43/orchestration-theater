// SPDX-License-Identifier: MPL-2.0
import {
  API_FALLBACK_MODES,
  CAPABILITY_CHECK_MODES,
  CROSS_CHECK_MODES,
  CROSS_CLIENT_MODES,
  EFFORT_LEVELS,
  FIXED_PROVIDER_OF_CLIENT,
  NEAR_LIMIT_MODES,
  ON_REGISTER_MODES,
  PRESET_SCOPES,
  PROFILE_NAME_PATTERN,
  RETRY_DIVERSITY_MODES,
  ROLE_PRESET_NAMES,
  SELECTION_STRATEGIES,
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
import { z } from 'zod';

/**
 * The Executors and the lists of the roles in the configuration (architecture 5.7; Phase 5, P13):
 * `executors.<id>`, `executors.cross_client`, `executors.on_register` and, under `roles`,
 * `preset`, `capability_check`, `allowed_profiles`, `roles.<role>.executors`, `.when_exhausted`
 * and `.requires`. The key names of `preset_scope` and `api_fallback`, and the spelling of
 * `requires.context` (`32k`), are [proposta]; the architecture fixes the rest.
 *
 * Every error names its key (`roles.author.executors.1: ...`): `describeZodError` prefixes the
 * path of the block. Nothing here changes what a play runs: the pipeline still reads
 * `orchestration.executor` until P16.
 */

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

/** One `executors.<id>` as written. */
const ExecutorEntryInputSchema = z.strictObject({
  client: z
    .string()
    .regex(PROFILE_NAME_PATTERN, { message: 'client: a client id such as "claude-code"' }),
  profile: z.string().regex(PROFILE_NAME_PATTERN, { message: 'profile: a profile name' }),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS, oneOf('effort', EFFORT_LEVELS)).optional(),
  provider: z.string().min(1).optional(),
});

/** The `executors` block, after parsing: the two modes and the registered Executors. */
export interface ExecutorsConfig {
  readonly cross_client: CrossClientMode;
  readonly on_register: OnRegisterMode;
  /** The `executors.<id>` entries by id, with the provider settled (5.7). */
  readonly entries: Readonly<Record<string, ExecutorEntry>>;
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
    const entries: Record<string, ExecutorEntry> = {};

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
      const name = tryParseExecutorId(key);
      if (typeof name === 'string') {
        issue(
          [key],
          `${name}; the keys of executors are "cross_client", "on_register" and Executor names`,
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
      };
    }
    return { cross_client, on_register, entries };
  });

/**
 * `selection` (architecture 5.7; Phase 5, P15): how the daemon picks among the Executors of a role.
 * `strategy` (N130) and `cross_check` are the architecture's; the defaults are its defaults.
 * [proposta] `unknown_quota` and `near_limit` are the keys N124 decided (`allow` and `keep_order`),
 * and `retry_diversity` and `context_reserve` are keys this passage adds so no default is hardcoded:
 * `retry_diversity` is how a retry starts after the Executor that failed (`rotate`: the 5.7 rule,
 * wrapping around), `context_reserve` the tokens the client keeps for its own prompt and tools,
 * which the prompt of a demand must leave free in the window (0 until measured).
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
});
export type SelectionConfig = z.infer<typeof SelectionConfigSchema>;
