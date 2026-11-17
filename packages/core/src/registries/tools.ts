// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { ideaGroupOutput } from './idea-group.js';
import { EXECUTOR_ROLE_IDS } from './roles.js';
import { isZodSchema, reportDuplicates, type ProblemCollector } from './problems.js';

/**
 * What a tool changes (architecture 5.21): `none` reads or only writes the framework's own
 * state, `worktree` writes inside the demand worktree, `external_write` reaches outside it (a
 * pull request, a message, a push).
 */
export const TOOL_EFFECT_CLASSES = ['none', 'worktree', 'external_write'] as const;
export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[number];

/**
 * How the idempotency key of a call is built (architecture 5.16). `attempt_step` is the only
 * kind of version 1: the attempt id plus the step counter, so a retried call after a crash hits
 * the same key.
 */
export const IDEMPOTENCY_KEY_KINDS = ['attempt_step'] as const;
export type IdempotencyKeyKind = (typeof IDEMPOTENCY_KEY_KINDS)[number];

/** What a verifier answers about a finished call (architecture 5.21, signature only here). */
export interface ToolVerification {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

/**
 * Checks, after a call that may have been cut short, whether its effect really happened. The
 * recovery on start-up uses it before it repeats an `external_write` call. Only the type lives
 * here; the verifiers come with the tools that need them.
 */
export type ToolVerifier = (call: {
  readonly input: unknown;
  readonly idempotencyKey: string;
}) => Promise<ToolVerification>;

/** A tool of the framework MCP server (architecture 5.3). */
export interface ToolDefinition {
  /** Lowercase snake case: the name the Executor calls. */
  readonly name: string;
  /** Roles that see the tool. */
  readonly roles: readonly string[];
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly effect: ToolEffectClass;
  /** Required when `effect` is `external_write`; optional (and used) for `worktree` tools. */
  readonly idempotencyKey?: IdempotencyKeyKind | undefined;
  readonly verifier?: ToolVerifier | undefined;
}

/** Pattern of a tool name: lowercase snake case. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// Simple shared shapes. The precise schemas of the remaining tools arrive with the step that
// implements them (the stage tools already have theirs: `planOutput`, `reviewOutput`, `scriptOutput`).
const noInput = z.strictObject({});
const accepted = z.strictObject({ ok: z.boolean() });
const id = z.string().min(1);
const json = z.record(z.string(), z.json());
const text = z.string();
/** The version of a blackboard key to read; omitted means the latest (P7). */
const blackboardVersion = z.int().min(1).optional();

/** One option of a question to the Producer (architecture 5.3, `ask_producer`). [proposta] field names. */
const askOption = z.strictObject({
  label: z.string().min(1).max(80),
  description: z.string().max(500),
});

/**
 * One question of `ask_producer`: 2 to 4 options with label and description, the recommended one
 * (by label), `multi_select` and `open` for a question that does not fit options. The interface
 * adds "Other" with free text by itself. Options are absent only on an `open` question; the
 * `chat.producer_questions` mode (`choices`, `choices_strict`, `free`) is applied by the daemon,
 * because it is a configuration key and not part of the schema. [proposta]
 */
export const askProducerQuestion = z
  .strictObject({
    question: z.string().min(1).max(500),
    options: z.array(askOption).min(2).max(4).optional(),
    recommended: z.string().min(1).max(80).optional(),
    multi_select: z.boolean().default(false),
    open: z.boolean().default(false),
  })
  .superRefine((q, ctx) => {
    const labels = (q.options ?? []).map((o) => o.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'option labels must be unique' });
    }
    if (q.recommended !== undefined && !labels.includes(q.recommended)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommended'],
        message: 'recommended must be the label of one of the options',
      });
    }
    if (q.multi_select && q.options === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['multi_select'],
        message: 'multi_select needs options',
      });
    }
  });

/** Input of `ask_producer`: 1 to 4 questions, answered at once (architecture 5.3). */
export const askProducerInput = z.strictObject({
  questions: z.array(askProducerQuestion).min(1).max(4),
});

const decisionBody = z.strictObject({ decisionId: id, payload: json });

/**
 * [proposta] What each role sends through its stage tool (architecture 5.3). One source: the tool
 * validates its input with these schemas, so a wrong shape goes back to the model inside the
 * `limits.submit_retries` loop, and the daemon reads the accepted output with the very same
 * schemas, so what the tool accepted can never fail to parse later. The objects are loose: an
 * extra field is kept and ignored. The descriptions go to the model through the JSON Schema the
 * MCP server announces.
 */
export const planOutput = z.looseObject({
  plan: z.string().min(1).describe('The plan, as text (not an object).'),
  openQuestions: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Questions only the Producer can answer, as plain strings; an empty list when there is none.',
    ),
});

/**
 * [proposta] The verdict of the Reviewer, of the Author over the script and of the Critic.
 * `reason` is required when `approved` is false (a veto the next attempt cannot read is a veto
 * without feedback); the machine itself still accepts a veto without one.
 */
export const reviewOutput = z
  .looseObject({
    approved: z.boolean().describe('true to approve; false to veto (then say why in "reason").'),
    reason: z.string().optional().describe('What is wrong, when not approved. Required then.'),
  })
  .superRefine((review, ctx) => {
    if (!review.approved && (review.reason === undefined || review.reason.trim() === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'a veto (approved: false) needs a non-empty reason',
      });
    }
  });

/**
 * [proposta] The script is only required to be there: its shape and rules are checked by
 * `parseScript` and `validateScript`, a counted loop of its own (`SCRIPT_VALIDATED`, N-th invalid
 * script), which must not turn into a failed submit.
 */
export const scriptOutput = z.looseObject({
  script: z.unknown().describe('The script: the object with "contracts" and "demands".'),
});

/**
 * [proposta] The tools of the orders (architecture 5.17). None of them saves anything: each one
 * writes a draft the Producer confirms (confirm / edit / cancel), so the output is the draft's id
 * with the validity already turned into dates (`preview`) and the orders it clashes with.
 * Dates are written `YYYY-MM-DD`, `YYYY-MM-DD HH:mm` or with an offset, read in the time zone of
 * the order; `for` is a duration such as `2h` or `3d`.
 */
const listDirectivesInput = z.strictObject({
  scenarioId: id.optional(),
  states: z.array(z.enum(['scheduled', 'active', 'expired', 'revoked'])).optional(),
});
const proposeDirectiveInput = z.strictObject({
  text: z.string().min(1),
  scope: z.enum(['global', 'local']),
  scenarioId: id.optional(),
  kind: z.enum(['instruction', 'rule', 'suspension']).optional(),
  roles: z.array(id).optional(),
  ruleKey: id.optional(),
  ruleValue: z.json().optional(),
  suspends: id.optional(),
  replaces: id.optional(),
  from: id.optional(),
  until: id.optional(),
  for: id.optional(),
});
const extendDirectiveInput = z.strictObject({
  directiveId: id,
  scenarioId: id.optional(),
  from: id.optional(),
  /** A new end, or `null` to leave the order with no end. */
  until: id.nullable().optional(),
  /** Adds this much to the current end (to the confirmation, when the order has none). */
  for: id.optional(),
});
const revokeDirectiveInput = z.strictObject({
  directiveId: id,
  scenarioId: id.optional(),
  reason: z.string().min(1),
});
const directiveDraftOutput = z.strictObject({
  draftId: id,
  preview: json,
  conflicts: z.array(id),
});

const COMMON = EXECUTOR_ROLE_IDS;

function tool(
  name: string,
  roles: readonly string[],
  input: z.ZodType,
  output: z.ZodType,
  extra: {
    effect?: ToolEffectClass;
    idempotencyKey?: IdempotencyKeyKind;
  } = {},
): ToolDefinition {
  return {
    name,
    roles,
    input,
    output,
    effect: extra.effect ?? 'none',
    ...(extra.idempotencyKey === undefined ? {} : { idempotencyKey: extra.idempotencyKey }),
  };
}

const DIRECTOR = ['director'] as const;

/**
 * [proposta] The tools of architecture 5.3 with simple schemas. Effect classes, the roles of the
 * `submit_*` tools and the `attempt_step` idempotency key of the worktree tools are choices of
 * this step; the architecture lists the tools per role set and says only that tools with effect
 * carry an idempotency key (5.16).
 */
export const OFFICIAL_TOOLS: readonly ToolDefinition[] = [
  // Director.
  tool('next_action', DIRECTOR, noInput, json),
  tool('status', DIRECTOR, z.strictObject({ play: id.optional() }), json),
  tool('decide', DIRECTOR, decisionBody, accepted),
  tool(
    'open_play',
    DIRECTOR,
    z.strictObject({ need: text.min(1) }),
    z.strictObject({ playId: id }),
  ),
  tool('pause', DIRECTOR, noInput, accepted),
  tool('resume', DIRECTOR, noInput, accepted),
  tool('cancel_actor', DIRECTOR, z.strictObject({ attemptId: id }), accepted),
  tool('ask_producer', DIRECTOR, askProducerInput, json),
  tool(
    'open_pr',
    DIRECTOR,
    z.strictObject({ title: text.min(1), body: text }),
    z.strictObject({ url: z.string() }),
    { effect: 'external_write', idempotencyKey: 'attempt_step' },
  ),
  tool('schedule', DIRECTOR, json, z.strictObject({ draftId: id })),
  tool('list_schedules', DIRECTOR, noInput, z.array(json)),
  tool('pause_schedule', DIRECTOR, z.strictObject({ scheduleId: id }), accepted),
  tool('list_directives', DIRECTOR, listDirectivesInput, z.array(json)),
  tool('propose_directive', DIRECTOR, proposeDirectiveInput, directiveDraftOutput),
  tool('extend_directive', DIRECTOR, extendDirectiveInput, directiveDraftOutput),
  tool('revoke_directive', DIRECTOR, revokeDirectiveInput, directiveDraftOutput),
  tool(
    'consult',
    DIRECTOR,
    z.strictObject({
      question: text.min(1),
      /** Attachments (`A<n>`) the consultant gets along with the question. */
      attachments: z.array(z.string().regex(/^A[1-9][0-9]*$/)).optional(),
      /** Why the Director chose to consult, and what the Producer asked for ("use o forte"). */
      reason: text.optional(),
    }),
    z.strictObject({ answer: text }),
  ),
  tool('promote', DIRECTOR, json, z.strictObject({ draftId: id })),
  tool(
    'run_task',
    DIRECTOR,
    z.strictObject({ taskId: id, inputs: json.optional() }),
    z.strictObject({ runId: id }),
  ),

  // Common to every Executor.
  tool(
    'read_blackboard',
    COMMON,
    z.strictObject({ key: id, version: blackboardVersion }),
    z.json(),
  ),
  tool('read_contract', COMMON, z.strictObject({ id, version: blackboardVersion }), json),
  tool('read_decision', COMMON, z.strictObject({ id }), json),
  tool('read_indication', COMMON, z.strictObject({ id }), json),
  // The Director reads text attachments too (N85); the handler refuses it any other kind.
  tool('read_attachment', [...COMMON, 'director'], z.strictObject({ id }), json),
  tool('submit', COMMON, z.strictObject({ result: json }), accepted),

  // Author, Reviewer, Scriptwriter.
  tool('submit_plan', ['author'], planOutput, accepted),
  tool('submit_plan_review', ['reviewer'], reviewOutput, accepted),
  tool('submit_script', ['scriptwriter'], scriptOutput, accepted),
  tool('submit_script_review', ['author'], reviewOutput, accepted),

  // Actor.
  tool('run_tests', ['actor', 'critic'], z.strictObject({ target: text.optional() }), json, {
    effect: 'worktree',
  }),
  tool('install_deps', ['actor'], noInput, accepted, {
    effect: 'worktree',
    idempotencyKey: 'attempt_step',
  }),
  tool(
    'git_commit',
    ['actor'],
    z.strictObject({ message: text.min(1) }),
    z.strictObject({ sha: id }),
    {
      effect: 'worktree',
      idempotencyKey: 'attempt_step',
    },
  ),
  tool('restricted_shell', ['actor'], z.strictObject({ argv: z.array(text).min(1) }), json, {
    effect: 'worktree',
    idempotencyKey: 'attempt_step',
  }),
  tool('http_get', ['actor', 'consultant'], z.strictObject({ url: z.url() }), json),

  // Critic.
  tool(
    'view_diff',
    ['critic'],
    z.strictObject({ demand: id.optional() }),
    z.strictObject({ diff: text }),
  ),
  tool('submit_critique', ['critic'], reviewOutput, accepted),

  // Idea queue of the scenario (P8, N91): the Author's judgment point `group_ideas`, outside the play.
  tool('submit_idea_group', ['author'], ideaGroupOutput, accepted),
];

export function validateTools(
  tools: readonly ToolDefinition[],
  roleIds: ReadonlySet<string>,
  collector: ProblemCollector,
): void {
  reportDuplicates(
    collector,
    tools.map((entry) => entry.name),
    'Tool',
  );
  for (const entry of tools) {
    const { name } = entry;
    if (!TOOL_NAME_PATTERN.test(name)) {
      collector.report(name, 'invalid_name', `Tool name "${name}" is not lowercase snake case`);
    }
    if (entry.roles.length === 0) {
      collector.report(name, 'empty_list', `Tool "${name}" is not visible to any role`);
    }
    for (const role of entry.roles) {
      if (!roleIds.has(role)) {
        collector.report(name, 'unknown_role', `Tool "${name}" names the unknown role "${role}"`);
      }
    }
    if (!isZodSchema(entry.input)) {
      collector.report(name, 'missing_schema', `Tool "${name}" has no input schema`);
    }
    if (!isZodSchema(entry.output)) {
      collector.report(name, 'missing_schema', `Tool "${name}" has no output schema`);
    }
    if (!(TOOL_EFFECT_CLASSES as readonly string[]).includes(entry.effect)) {
      collector.report(
        name,
        'invalid_effect_class',
        `Tool "${name}" has the effect class ${JSON.stringify(entry.effect)}; use none, worktree or external_write`,
      );
    } else if (entry.effect === 'external_write' && entry.idempotencyKey === undefined) {
      collector.report(
        name,
        'missing_idempotency_key',
        `Tool "${name}" is external_write and has no idempotency key`,
      );
    }
    if (
      entry.idempotencyKey !== undefined &&
      !(IDEMPOTENCY_KEY_KINDS as readonly string[]).includes(entry.idempotencyKey)
    ) {
      collector.report(
        name,
        'missing_idempotency_key',
        `Tool "${name}" has the unknown idempotency key kind ${JSON.stringify(entry.idempotencyKey)}`,
      );
    }
  }
}
