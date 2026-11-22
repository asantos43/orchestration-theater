// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { ideaGroupOutput } from './idea-group.js';
import { EXECUTOR_ROLE_IDS } from './roles.js';
import { isZodSchema, reportDuplicates, type ProblemCollector } from './problems.js';

/**
 * What a tool changes (architecture 5.14 and 5.21; N237 (a), 2026-11-21: the code uses the
 * vocabulary of the architecture, renamed one to one from the old `none` and `worktree`):
 * - `read`: reads, or only writes the framework's own state;
 * - `local_write`: writes inside the demand worktree;
 * - `network`: reaches the network without changing anything outside (a page, a download);
 * - `external_write`: changes something outside the worktree (a pull request, a message, a push).
 */
export const TOOL_EFFECT_CLASSES = ['read', 'local_write', 'network', 'external_write'] as const;
export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[number];

/**
 * The classes whose calls need an idempotency key. [proposta] `network` is treated like
 * `external_write` here, the conservative side (N237 (b) said the same for the manifest): a call
 * that reaches the network may have already left when the daemon stops, so a retried call has to
 * hit the same key (architecture 5.16 lists `network` among the effects that carry one).
 */
export const IDEMPOTENT_EFFECT_CLASSES: readonly ToolEffectClass[] = ['network', 'external_write'];

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
  /** Required when `effect` is `network` or `external_write`; optional (and used) for `local_write` tools. */
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

/**
 * [proposta] The work tools of the Executors (architecture 5.8, N97 and N98). What a command
 * printed is cut to `tools.output_max_bytes`: `truncated` says it, and `stdoutBytes` and
 * `stderrBytes` are the sizes before the cut. `exitCode` is `null` when the process did not exit
 * by itself (`timedOut`, the tree was killed). The command of `run_tests` and `install_deps`
 * never comes from the model: `target` only narrows what the project's own command runs.
 */
const restrictedShellInput = z.strictObject({ argv: z.array(text).min(1).max(256) });
const runTestsInput = z.strictObject({ target: text.max(4096).optional() });
const gitCommitInput = z.strictObject({ message: text.min(1).max(10_000) });
const viewDiffInput = z.strictObject({ demand: id.optional() });
const httpGetInput = z.strictObject({ url: z.url().max(4096) });

/**
 * [proposta] The browser tools (architecture 5.19). `ref` is the id of an element in the tree of
 * the last `browser_read` of the scenario. `url` of `browser_open` is any absolute URL the guard of
 * the scenario allows, `file:` included, so it is a plain string here. Whatever the page said
 * comes out marked `untrusted: true`, as `http_get` does.
 */
const browserRef = z.string().min(1).max(64);
const browserOpenInput = z.strictObject({ url: z.string().min(1).max(4096) });
const browserReadInput = z.strictObject({ ref: browserRef.optional() });
const browserScreenshotInput = z.strictObject({ ref: browserRef.optional() });
const browserClickInput = z.strictObject({ ref: browserRef });
const browserFillInput = z.strictObject({ ref: browserRef, value: z.string().max(100_000) });
const browserPressKeyInput = z.strictObject({ key: z.string().min(1).max(64) });

const commandOutput = z.strictObject({
  exitCode: z.int().nullable(),
  stdout: text,
  stderr: text,
  truncated: z.boolean(),
  durationMs: z.int().min(0),
  timedOut: z.boolean(),
  stdoutBytes: z.int().min(0),
  stderrBytes: z.int().min(0),
  /**
   * `install_deps` only (P22): `true` when an earlier run of the same call (same command, same
   * dependency files) had finished, so its recorded result is returned and nothing ran.
   */
  reused: z.boolean().optional(),
});

/** `reused`: the commit of an earlier call with the same step was found, nothing was committed again. */
const gitCommitOutput = z.strictObject({ sha: id, reused: z.boolean() });

const viewDiffOutput = z.strictObject({
  diff: text,
  truncated: z.boolean(),
  originalBytes: z.int().min(0),
});

/** `untrusted` is always `true`: the body is data from the network, never instructions. */
const httpGetOutput = z.strictObject({
  url: text,
  status: z.int(),
  contentType: text.nullable(),
  body: text,
  truncated: z.boolean(),
  originalBytes: z.int().min(0),
  untrusted: z.literal(true),
});

const browserPage = { url: text, title: text };
const browserOpenOutput = z.strictObject({ ...browserPage, untrusted: z.literal(true) });
const browserReadOutput = z.strictObject({
  ...browserPage,
  text,
  tree: text,
  truncated: z.boolean(),
  untrusted: z.literal(true),
});
/** The image itself travels as an image block of the tool result; this is what is about it. */
const browserScreenshotOutput = z.strictObject({
  ...browserPage,
  mimeType: z.literal('image/png'),
  bytes: z.int().min(0),
  untrusted: z.literal(true),
});
/** `reused`: the action of an earlier call with the same step was found, nothing was done again. */
const browserActionOutput = z.strictObject({
  ...browserPage,
  reused: z.boolean(),
  untrusted: z.literal(true),
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
    effect: extra.effect ?? 'read',
    ...(extra.idempotencyKey === undefined ? {} : { idempotencyKey: extra.idempotencyKey }),
  };
}

const DIRECTOR = ['director'] as const;
/** The roles that browse: the Actor and the consultant (architecture 5.8 and 5.19). */
const BROWSER_ROLES = ['actor', 'consultant'] as const;
/**
 * `http_get` and the browser reads reach the network (architecture 5.19), so they are `network`,
 * which carries an idempotency key like `external_write` ({@link IDEMPOTENT_EFFECT_CLASSES}).
 * Decision of 2026-11-22 (N243, item 7): they were `read` since the renaming of the classes.
 */
const NETWORK_READ = {
  effect: 'network',
  idempotencyKey: 'attempt_step',
} as const;
const BROWSER_WRITE = {
  effect: 'external_write',
  idempotencyKey: 'attempt_step',
} as const;

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
    z.strictObject({
      answer: text,
      /** [proposta] P10: the files the consultant wrote that now are in the chat folder. */
      files: z.array(text).optional(),
      /** [proposta] P10: why the consultant's files did not reach the folder, when they did not. */
      notice: text.optional(),
    }),
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
  tool('run_tests', ['actor', 'critic'], runTestsInput, commandOutput, { effect: 'local_write' }),
  tool('install_deps', ['actor'], noInput, commandOutput, {
    effect: 'local_write',
    idempotencyKey: 'attempt_step',
  }),
  tool('git_commit', ['actor'], gitCommitInput, gitCommitOutput, {
    effect: 'local_write',
    idempotencyKey: 'attempt_step',
  }),
  tool('restricted_shell', ['actor'], restrictedShellInput, commandOutput, {
    effect: 'local_write',
    idempotencyKey: 'attempt_step',
  }),
  tool('http_get', ['actor', 'consultant'], httpGetInput, httpGetOutput, NETWORK_READ),
  tool('browser_open', BROWSER_ROLES, browserOpenInput, browserOpenOutput, NETWORK_READ),
  tool('browser_read', BROWSER_ROLES, browserReadInput, browserReadOutput, NETWORK_READ),
  tool(
    'browser_screenshot',
    BROWSER_ROLES,
    browserScreenshotInput,
    browserScreenshotOutput,
    NETWORK_READ,
  ),
  tool('browser_click', BROWSER_ROLES, browserClickInput, browserActionOutput, BROWSER_WRITE),
  tool('browser_fill', BROWSER_ROLES, browserFillInput, browserActionOutput, BROWSER_WRITE),
  tool(
    'browser_press_key',
    BROWSER_ROLES,
    browserPressKeyInput,
    browserActionOutput,
    BROWSER_WRITE,
  ),

  // Critic.
  tool('view_diff', ['critic'], viewDiffInput, viewDiffOutput),
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
        `Tool "${name}" has the effect class ${JSON.stringify(entry.effect)}; use read, local_write, network or external_write`,
      );
    } else if (
      IDEMPOTENT_EFFECT_CLASSES.includes(entry.effect) &&
      entry.idempotencyKey === undefined
    ) {
      collector.report(
        name,
        'missing_idempotency_key',
        `Tool "${name}" is ${entry.effect} and has no idempotency key`,
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
