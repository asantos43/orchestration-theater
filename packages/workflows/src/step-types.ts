// SPDX-License-Identifier: MPL-2.0
import { DELIVERY_MODES, type RoleId } from '@otheater/core';
import { z } from 'zod';
import { DURATION_PATTERN } from './definition.js';
import { NO_OUTPUT, type FieldType } from './field-types.js';

/**
 * The step types the engine knows (docs/24, §4). This package only declares them: the params, the
 * typed output the conditions read, the role, the effects and the safe points. The runtime that
 * executes them is in the daemon (P2, P3). A new step type only comes in through an official
 * module, so through a new version; what does not change the engine goes through `call_tool`.
 */

/** A write that others see: what `workflows.security.require_approval` names. */
export const PUBLIC_WRITES = ['push', 'comment', 'label'] as const;
export type PublicWrite = (typeof PUBLIC_WRITES)[number];

/** What a step can cause, for the permissions of a package (N298) and the audit. */
export const STEP_EFFECTS = [
  'none',
  'read_code_host',
  'write_code_host',
  'agent',
  'workspace',
  'producer',
  'notify',
  'tool',
] as const;
export type StepEffect = (typeof STEP_EFFECTS)[number];

export interface StepRoleSpec {
  /** The role when the node names none. */
  readonly default: RoleId;
  /** The roles a node may name. */
  readonly allowed: readonly RoleId[];
}

export interface StepTypeSpec {
  readonly id: string;
  readonly description: string;
  /** The params of a node of this type. */
  readonly params: z.ZodType;
  /** The typed output, read by `output.<field>` in the conditions of the edges that leave it. */
  readonly output: FieldType;
  /** `null`: the step uses no role. */
  readonly role: StepRoleSpec | null;
  readonly effects: readonly StepEffect[];
  /** A run may move to a new version of its definition between steps only at a safe point (N295). */
  readonly safePoint: boolean;
  /** The public writes of a node with these params (already checked against `params`). */
  readonly publicWrites: (params: Readonly<Record<string, unknown>>) => readonly PublicWrite[];
  /**
   * Whether a node of this type stands for the human approval before the public writes after it
   * (or its own). `approval` always does.
   */
  readonly approves: (params: Readonly<Record<string, unknown>>) => boolean;
}

const none = (): readonly PublicWrite[] => [];
const never = (): boolean => false;
const Duration = z.string().regex(DURATION_PATTERN, 'a duration like 30m or 4h');
const NoParams = z.strictObject({});

function role(defaultRole: RoleId, allowed: readonly RoleId[] = [defaultRole]): StepRoleSpec {
  return { default: defaultRole, allowed };
}

function spec(
  fields: Omit<StepTypeSpec, 'publicWrites' | 'approves' | 'params'> &
    Partial<Pick<StepTypeSpec, 'publicWrites' | 'approves' | 'params'>>,
): StepTypeSpec {
  return { params: NoParams, publicWrites: none, approves: never, ...fields };
}

/** Generic steps (docs/24, §4). */
export const GENERIC_STEP_TYPES: readonly StepTypeSpec[] = [
  spec({
    id: 'call_tool',
    description: 'Calls a framework or plugin tool, by MCP, out of the process.',
    params: z.strictObject({
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown()).optional(),
      timeout: Duration.optional(),
    }),
    output: { object: { ok: 'boolean', result: 'unknown' } },
    role: null,
    effects: ['tool'],
    safePoint: true,
  }),
  spec({
    id: 'wait_event',
    description: 'Waits for a typed event, with a deadline.',
    params: z.strictObject({
      event: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
      timeout: Duration,
    }),
    output: { object: { timed_out: 'boolean', event: 'unknown' } },
    role: null,
    effects: ['none'],
    safePoint: true,
  }),
  spec({
    id: 'branch',
    description: 'Chooses the edge by condition; does nothing else.',
    output: NO_OUTPUT,
    role: null,
    effects: ['none'],
    safePoint: true,
  }),
  spec({
    id: 'approval',
    description: 'Human approval by the chat or the interface, with a deadline.',
    params: z.strictObject({
      prompt: z.string().min(1).optional(),
      timeout: Duration.optional(),
      /** [proposta] `stop`: the run ends as cancelled; `reject`: the output is not approved. */
      on_timeout: z.enum(['stop', 'reject']).optional(),
    }),
    output: { object: { approved: 'boolean' } },
    role: null,
    effects: ['producer'],
    safePoint: true,
    approves: () => true,
  }),
  spec({
    id: 'notify',
    description: 'Sends a notice to the Producer.',
    params: z.strictObject({ message: z.string().min(1) }),
    output: NO_OUTPUT,
    role: null,
    effects: ['notify'],
    safePoint: true,
  }),
];

const IssueOutput: FieldType = {
  object: {
    number: 'number',
    title: 'string',
    state: { enum: ['open', 'closed'] },
    labels: { list: 'string' },
    author: 'string',
  },
};

/** Code host steps (docs/24, §4): three that only read, two that write in public. */
export const CODE_HOST_STEP_TYPES: readonly StepTypeSpec[] = [
  spec({
    id: 'fetch_issue',
    description: 'Reads the issue of the trigger or of `params.number`.',
    params: z.strictObject({ number: z.number().int().positive().optional() }),
    output: IssueOutput,
    role: null,
    effects: ['read_code_host'],
    safePoint: true,
  }),
  spec({
    id: 'fetch_pr',
    description: 'Reads the pull request of the trigger or of `params.number`.',
    params: z.strictObject({ number: z.number().int().positive().optional() }),
    output: {
      object: {
        number: 'number',
        title: 'string',
        state: { enum: ['open', 'closed', 'merged'] },
        draft: 'boolean',
        labels: { list: 'string' },
        author: 'string',
      },
    },
    role: null,
    effects: ['read_code_host'],
    safePoint: true,
  }),
  spec({
    id: 'fetch_ci_log',
    description: 'Reads the log of the failed checks of a pull request.',
    params: z.strictObject({ max_bytes: z.number().int().positive().optional() }),
    output: { object: { failed: 'boolean', checks: { list: 'string' } } },
    role: null,
    effects: ['read_code_host'],
    safePoint: true,
  }),
  spec({
    id: 'comment',
    description: 'Comments on the issue or the pull request.',
    params: z.strictObject({
      target: z.enum(['issue', 'pr']),
      body: z.string().min(1).optional(),
      /**
       * [proposta] (P12) The id of a `run_play` node of this run: the body is the summary the play
       * left (a later node cannot read the output of an earlier one yet). `body` wins when both are set.
       */
      body_from: z.string().min(1).optional(),
    }),
    output: { object: { url: 'string' } },
    role: null,
    effects: ['write_code_host'],
    safePoint: true,
    publicWrites: () => ['comment'],
  }),
  spec({
    id: 'label',
    description: 'Adds or removes labels on the issue or the pull request.',
    params: z.strictObject({
      target: z.enum(['issue', 'pr']),
      add: z.array(z.string().min(1)).optional(),
      remove: z.array(z.string().min(1)).optional(),
    }),
    output: NO_OUTPUT,
    role: null,
    effects: ['write_code_host'],
    safePoint: true,
    publicWrites: () => ['label'],
  }),
];

/**
 * The steps of the play (docs/24, §4), with the outputs of the events of the machine of today
 * (`PLAN_SUBMITTED.hasOpenQuestions`, `PLAN_REVIEWED.approved` and the others). [proposta]
 */
export const PLAY_STEP_TYPES: readonly StepTypeSpec[] = [
  spec({
    id: 'plan',
    description: 'The Director writes the plan of the need.',
    params: z.strictObject({ prompt: z.string().min(1).optional() }),
    output: { object: { has_open_questions: 'boolean' } },
    role: role('director'),
    effects: ['agent'],
    safePoint: true,
  }),
  spec({
    id: 'clarify',
    description: 'Asks the open questions of the plan to the Producer.',
    output: NO_OUTPUT,
    role: null,
    effects: ['producer'],
    safePoint: true,
  }),
  spec({
    id: 'review',
    description: 'The Reviewer reviews the plan or the script.',
    params: z.strictObject({ subject: z.enum(['plan', 'script']) }),
    output: { object: { approved: 'boolean' } },
    role: role('reviewer'),
    effects: ['agent'],
    safePoint: true,
  }),
  spec({
    id: 'script',
    description: 'The Scriptwriter turns the plan into the DAG of demands.',
    output: { object: { valid: 'boolean' } },
    role: role('scriptwriter'),
    effects: ['agent'],
    safePoint: true,
  }),
  spec({
    id: 'execute_dag',
    description: 'The Actors run the demands of the script, by the DAG.',
    output: { object: { outcome: { enum: ['completed', 'restart_script', 'restart_plan'] } } },
    role: role('actor'),
    effects: ['agent', 'workspace'],
    // A run in the middle of its demands is not a safe point (N295).
    safePoint: false,
  }),
  spec({
    id: 'integrate',
    description: 'Integrates the branches of the demands.',
    output: { object: { ok: 'boolean' } },
    role: null,
    effects: ['workspace'],
    safePoint: true,
  }),
  spec({
    id: 'critique',
    description: 'The Critic judges the integrated result.',
    output: { object: { approved: 'boolean' } },
    role: role('critic'),
    effects: ['agent'],
    safePoint: true,
  }),
  spec({
    id: 'decide',
    description: 'The Director judges what the rejection of the Critic calls for.',
    output: { object: { decision: { enum: ['script', 'execution', 'producer'] } } },
    role: role('director'),
    effects: ['agent'],
    safePoint: true,
  }),
  spec({
    id: 'deliver',
    description: 'Delivers by branch, PR or merge, by `delivery.mode`.',
    params: z.strictObject({
      /** Absent: the `delivery.mode` of the rules (5.5, 5.17). */
      mode: z.enum(DELIVERY_MODES).optional(),
      link_issue: z.enum(['fixes', 'refs', 'none']).optional(),
    }),
    output: { object: { outcome: { enum: ['delivered', 'ask_producer'] } } },
    role: null,
    effects: ['workspace', 'write_code_host'],
    safePoint: true,
    publicWrites: () => ['push'],
    // [proposta] With no mode, the delivery follows the `delivery.mode` of the Producer's rules
    // (where `ask` asks before the push); `ask` itself asks. A mode fixed as `pr` or
    // `direct_merge` in the definition goes around those rules, so it needs an `approval` first.
    approves: (params) => params.mode === undefined || params.mode === 'ask',
  }),
  spec({
    id: 'await_producer',
    description: 'Waits for the choice of the Producer on an exception or a question. [proposta]',
    output: {
      object: { choice: { enum: ['plan', 'script', 'execution', 'deliver', 'cancel'] } },
    },
    role: null,
    effects: ['producer'],
    safePoint: true,
  }),
];

/**
 * The bridge between a generic workflow and the play of today (Phase 11b, P12; decision of the owner
 * of 2026-11-28). [proposta] The params and the output.
 *
 * `run_play` opens a play through the runner that exists (the machine of `pipeline/`), with the need
 * built from the issue, the pull request or the CI log of the run, waits for the play to reach a
 * final state and returns what it left. The play delivers by itself (push and PR, by
 * `delivery.mode`), so the node counts as a `push`: the definition needs an `approval` before it.
 * It goes away when the `play` runs on this engine (P10c).
 */
export const BRIDGE_STEP_TYPES: readonly StepTypeSpec[] = [
  spec({
    id: 'run_play',
    description:
      'Opens a play for the issue, the pull request or the CI log, and waits for its end.',
    params: z.strictObject({
      /** What the need of the play is built from. */
      from: z.enum(['issue', 'pr', 'ci_log']),
      /** Absent: the number the trigger gave (`issue` or `pr` input of the run). */
      number: z.number().int().positive().optional(),
      /** What the play is asked to do with it; absent: a default by `from`. */
      instructions: z.string().min(1).optional(),
      /** The longest the step waits for the play; absent: until it ends. The play keeps running. */
      timeout: Duration.optional(),
    }),
    output: {
      object: {
        ended: { enum: ['done', 'cancelled'] },
        delivered: 'boolean',
        branch: 'string',
        pr_number: 'number',
        pr_url: 'string',
        summary: 'string',
        play_id: 'string',
      },
    },
    role: null,
    effects: ['agent', 'workspace', 'write_code_host'],
    // A run in the middle of a play is not a safe point (N295).
    safePoint: false,
    publicWrites: () => ['push'],
  }),
];

/** The registry of step types of engine version 1. */
export const BUILTIN_STEP_TYPES: readonly StepTypeSpec[] = [
  ...GENERIC_STEP_TYPES,
  ...CODE_HOST_STEP_TYPES,
  ...PLAY_STEP_TYPES,
  ...BRIDGE_STEP_TYPES,
];

/** A lookup by id; a duplicated id is an error of the caller. */
export function stepTypeRegistry(
  types: readonly StepTypeSpec[],
): ReadonlyMap<string, StepTypeSpec> {
  const map = new Map<string, StepTypeSpec>();
  for (const type of types) {
    if (map.has(type.id)) throw new Error(`step type ${type.id} declared twice`);
    map.set(type.id, type);
  }
  return map;
}
