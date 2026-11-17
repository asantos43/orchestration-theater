// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { isZodSchema, reportDuplicates, type ProblemCollector } from './problems.js';
import { ROLE_ID_PATTERN } from './roles.js';

/**
 * Where the daemon applies a `rule` key (architecture 5.17): the decision that reads the
 * override instead of the configuration.
 */
export const RULE_APPLICATION_POINTS = ['selection', 'quota', 'delivery', 'vcs', 'chat'] as const;
export type RuleApplicationPoint = (typeof RULE_APPLICATION_POINTS)[number];

/**
 * A key a `rule` directive may override (architecture 5.17). The list is closed: six keys in
 * version 1, and a new key comes one at a time, with a test.
 */
export interface RuleKeyDefinition {
  /** Dotted configuration key (`git.push_after_commit`). */
  readonly key: string;
  /** Schema of the value the directive carries. */
  readonly value: z.ZodType;
  readonly appliesAt: RuleApplicationPoint;
}

/** Pattern of a rule key: two or more lowercase snake-case segments joined by dots. */
export const RULE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * [proposta] Families a `rule` can never touch: permissions are changed in the role
 * configuration, not by a directive (architecture 5.17, "Chaves de permissão ficam fora"; 5.8).
 */
export const FORBIDDEN_RULE_FAMILIES = ['security', 'permissions', 'sandbox'] as const;

const roleId = z.string().regex(ROLE_ID_PATTERN);

export const PRODUCER_QUESTION_MODES = ['choices', 'choices_strict', 'free'] as const;
export const UNANSWERED_MODES = ['wait_then_recommended', 'wait', 'recommended_now'] as const;
export const EXHAUSTED_MODES = ['next', 'wait'] as const;
export const DELIVERY_MODES = ['pr', 'direct_merge', 'ask'] as const;

/**
 * [proposta] The six keys of version 1 (architecture 5.17). The architecture names the keys by
 * what they do; the names of the first three and the shape of every value are not fixed by it:
 * - `roles.executors`: take Executors out of the list of a role, or reorder it (5.7);
 * - `roles.when_exhausted`: `next` or `wait` for a role (5.7);
 * - `delivery.mode`: the delivery policy (5.5); a rule that demands a PR sets `pr`;
 * - `git.push_after_commit`: the daemon pushes the demand branch after each `git_commit`;
 * - `chat.producer_questions` and `chat.unanswered` (5.3).
 */
export const OFFICIAL_RULE_KEYS: readonly RuleKeyDefinition[] = [
  {
    key: 'roles.executors',
    appliesAt: 'selection',
    value: z
      .strictObject({
        role: roleId,
        /** Executors (`<model>-<effort>@<client>/<profile>`) removed from the list of the role. */
        exclude: z.array(z.string().min(1)).optional(),
        /** The list in the new order; an Executor not named here is left out. */
        order: z.array(z.string().min(1)).min(1).optional(),
      })
      .refine((value) => value.exclude !== undefined || value.order !== undefined, {
        message: 'give "exclude", "order" or both',
      }),
  },
  {
    key: 'roles.when_exhausted',
    appliesAt: 'quota',
    value: z.strictObject({ role: roleId, mode: z.enum(EXHAUSTED_MODES) }),
  },
  { key: 'delivery.mode', appliesAt: 'delivery', value: z.enum(DELIVERY_MODES) },
  { key: 'git.push_after_commit', appliesAt: 'vcs', value: z.boolean() },
  {
    key: 'chat.producer_questions',
    appliesAt: 'chat',
    value: z.enum(PRODUCER_QUESTION_MODES),
  },
  {
    key: 'chat.unanswered',
    appliesAt: 'chat',
    value: z.strictObject({
      mode: z.enum(UNANSWERED_MODES),
      /** A duration such as `30m`; `0` waits without a deadline. */
      wait_for: z
        .string()
        .regex(/^(0|\d+(ms|s|m|h|d))$/)
        .optional(),
    }),
  },
];

export function validateRuleKeys(
  keys: readonly RuleKeyDefinition[],
  collector: ProblemCollector,
): void {
  reportDuplicates(
    collector,
    keys.map((entry) => entry.key),
    'Rule key',
  );
  for (const entry of keys) {
    if (!RULE_KEY_PATTERN.test(entry.key)) {
      collector.report(
        entry.key,
        'invalid_name',
        `Rule key "${entry.key}" is not a dotted lowercase key such as git.push_after_commit`,
      );
    } else {
      const family = entry.key.split('.')[0] ?? '';
      if ((FORBIDDEN_RULE_FAMILIES as readonly string[]).includes(family)) {
        collector.report(
          entry.key,
          'reserved_rule_key',
          `Rule key "${entry.key}" is in the "${family}" family; permissions are not changed by a directive`,
        );
      }
    }
    if (!isZodSchema(entry.value)) {
      collector.report(entry.key, 'missing_schema', `Rule key "${entry.key}" has no value schema`);
    }
  }
}
