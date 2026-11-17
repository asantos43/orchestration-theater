// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
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

// Simple shared shapes. The precise schemas of each tool arrive with the step that implements it.
const noInput = z.strictObject({});
const accepted = z.strictObject({ ok: z.boolean() });
const id = z.string().min(1);
const json = z.record(z.string(), z.json());
const text = z.string();
const decisionBody = z.strictObject({ decisionId: id, payload: json });

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
  tool('ask_producer', DIRECTOR, z.strictObject({ questions: z.array(json).min(1).max(4) }), json),
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
  tool('list_directives', DIRECTOR, noInput, z.array(json)),
  tool('propose_directive', DIRECTOR, json, z.strictObject({ draftId: id })),
  tool('extend_directive', DIRECTOR, json, z.strictObject({ draftId: id })),
  tool(
    'revoke_directive',
    DIRECTOR,
    z.strictObject({ directiveId: id }),
    z.strictObject({ draftId: id }),
  ),
  tool(
    'consult',
    DIRECTOR,
    z.strictObject({ question: text.min(1) }),
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
  tool('read_blackboard', COMMON, z.strictObject({ key: id }), z.json()),
  tool('read_contract', COMMON, z.strictObject({ id }), json),
  tool('read_decision', COMMON, z.strictObject({ id }), json),
  tool('read_indication', COMMON, z.strictObject({ id }), json),
  tool('read_attachment', COMMON, z.strictObject({ id }), json),
  tool('submit', COMMON, z.strictObject({ result: json }), accepted),

  // Author, Reviewer, Scriptwriter.
  tool('submit_plan', ['author'], json, accepted),
  tool('submit_plan_review', ['reviewer'], json, accepted),
  tool('submit_script', ['scriptwriter'], json, accepted),
  tool('submit_script_review', ['author'], json, accepted),

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
  tool('http_get', ['actor'], z.strictObject({ url: z.url() }), json),

  // Critic.
  tool(
    'view_diff',
    ['critic'],
    z.strictObject({ demand: id.optional() }),
    z.strictObject({ diff: text }),
  ),
  tool('submit_critique', ['critic'], json, accepted),
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
