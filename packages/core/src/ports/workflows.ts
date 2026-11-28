// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, JsonObjectSchema, RecordIdSchema } from './store-schemas.js';

/**
 * The workflow library and the bindings of the scenarios (docs/24 section 7, N296; plan of
 * Phase 11b, P5). Two tables, `workflow_definitions` and `workflow_bindings`. Every column is
 * [proposta]. The definition is kept as an opaque JSON object: `@otheater/workflows` validates
 * it and computes the hash (the core never imports that package), and the registry only checks
 * what it can see: the id and the version of the record agree with the document.
 */

const text = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// the library: workflow_definitions
// ---------------------------------------------------------------------------------------------

/** Where a definition came from: the product (`play`), the user, or an installed package (P9). */
export const WORKFLOW_SOURCES = ['builtin', 'user', 'package'] as const;
export type WorkflowSource = (typeof WORKFLOW_SOURCES)[number];

/**
 * `active` is the version new runs are born in (at most one per workflow id); `inactive` is a
 * saved version, kept for the runs that were born in it and for bindings that pin it.
 */
export const WORKFLOW_DEFINITION_STATES = ['active', 'inactive'] as const;
export type WorkflowDefinitionState = (typeof WORKFLOW_DEFINITION_STATES)[number];

/** Same shape as the `id` of a definition (`@otheater/workflows`): lowercase, with `_` or `-`. */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Semantic version without build metadata: `1.0.0`, `2.1.0-rc.1`. */
export const WORKFLOW_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** `sha256:<hex>`, the stable hash of the canonical definition. */
export const WORKFLOW_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

const workflowId = z.string().regex(WORKFLOW_ID_PATTERN);
const workflowVersion = z.string().regex(WORKFLOW_VERSION_PATTERN);

/** One row of `workflow_definitions`; the key is `(workflowId, version)`. */
export const WorkflowDefinitionRecordSchema = z.strictObject({
  workflowId,
  version: workflowVersion,
  /** Order in which the versions were saved, across the whole library, from 1. */
  seq: z.int().min(1),
  hash: z.string().regex(WORKFLOW_HASH_PATTERN),
  /** The validated document (`id` and `version` in it equal the two columns above). */
  definition: JsonObjectSchema,
  source: z.enum(WORKFLOW_SOURCES),
  /** The package it came from, when `source` is `package`. */
  packageId: text.nullable(),
  state: z.enum(WORKFLOW_DEFINITION_STATES),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** When it last became the active version; null while it never was. */
  activatedAt: EpochMsSchema.nullable(),
});
export type WorkflowDefinitionRecord = z.infer<typeof WorkflowDefinitionRecordSchema>;

/** What a caller writes; the store assigns `seq`, the state (`inactive`) and the dates. */
export const NewWorkflowDefinitionSchema = z
  .strictObject({
    workflowId,
    version: workflowVersion,
    hash: z.string().regex(WORKFLOW_HASH_PATTERN),
    definition: JsonObjectSchema,
    source: z.enum(WORKFLOW_SOURCES),
    packageId: text.nullable().optional(),
  })
  .superRefine((given, ctx) => {
    if (given.definition.id !== given.workflowId) {
      ctx.addIssue({
        code: 'custom',
        path: ['definition', 'id'],
        message: 'differs from workflowId',
      });
    }
    if (given.definition.version !== given.version) {
      ctx.addIssue({
        code: 'custom',
        path: ['definition', 'version'],
        message: 'differs from version',
      });
    }
    if (given.source === 'package' && (given.packageId ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['packageId'],
        message: 'a package definition names its package',
      });
    }
    if (given.source !== 'package' && (given.packageId ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['packageId'],
        message: 'only a package definition has a packageId',
      });
    }
  });
export type NewWorkflowDefinition = z.infer<typeof NewWorkflowDefinitionSchema>;

export interface WorkflowDefinitionListFilter {
  readonly workflowId?: string;
  /** Only definitions in one of these states. Omitted means all. */
  readonly states?: readonly WorkflowDefinitionState[];
  readonly source?: WorkflowSource;
}

/**
 * The library, part of `Store` (`store.workflowDefinitions`). Contract
 * (`describeWorkflowAggregatesConformance`):
 * - `put` validates (`InvalidInput`) and stores the version `inactive`. A version is immutable:
 *   putting the same `(workflowId, version)` again with the same hash resolves with the stored
 *   record, and with another hash it is a `Conflict`.
 * - `get(workflowId, version)`, `active(workflowId)` (the active version, or `undefined`) and
 *   `list`; `list` is ordered by `workflowId`, then `seq`.
 * - `activate` makes a version the active one and turns the previous active version of the
 *   workflow `inactive`, in one step (`NotFound` for an unknown version). Activating the active
 *   version changes nothing.
 * - `deactivate` turns the active version `inactive`, so the workflow has none (P10b, [proposta]):
 *   a library with no active version resolves nothing new, and a package can leave. `NotFound` for
 *   an unknown version; on a version that is not the active one it changes nothing. `activatedAt`
 *   stays as it was.
 * - `remove` deletes an `inactive` version (`NotFound` for an unknown one, `Conflict` for the
 *   active one). The library, not the store, checks that no live run is born in it.
 */
export interface WorkflowDefinitionRegistry {
  put(input: NewWorkflowDefinition): Promise<WorkflowDefinitionRecord>;
  get(workflowId: string, version: string): Promise<WorkflowDefinitionRecord | undefined>;
  active(workflowId: string): Promise<WorkflowDefinitionRecord | undefined>;
  list(filter?: WorkflowDefinitionListFilter): Promise<readonly WorkflowDefinitionRecord[]>;
  activate(workflowId: string, version: string): Promise<WorkflowDefinitionRecord>;
  deactivate(workflowId: string, version: string): Promise<WorkflowDefinitionRecord>;
  remove(workflowId: string, version: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// the bindings: workflow_bindings
// ---------------------------------------------------------------------------------------------

/**
 * The life cycle of a binding (docs/24 section 7): `active` fires its triggers, `paused` does not
 * (the Producer paused it, or the budget of the period ran out), `stopped` and `expired` are
 * final (the Producer stopped it, or its deadline passed).
 */
export const WORKFLOW_BINDING_STATES = ['active', 'paused', 'stopped', 'expired'] as const;
export type WorkflowBindingState = (typeof WORKFLOW_BINDING_STATES)[number];

/** The states a binding never leaves. */
export const WORKFLOW_BINDING_FINAL_STATES = ['stopped', 'expired'] as const;

/** Why a binding is in its state (and what ended it). `null` while it is `active`. */
export const WORKFLOW_BINDING_REASONS = ['producer', 'budget', 'deadline'] as const;
export type WorkflowBindingReason = (typeof WORKFLOW_BINDING_REASONS)[number];

/** What to do with a trigger that arrives while the binding is at its `concurrency`. */
export const WORKFLOW_ON_BUSY = ['queue', 'skip', 'replace'] as const;
export type WorkflowOnBusy = (typeof WORKFLOW_ON_BUSY)[number];

/**
 * The length of a budget period: a window of `day` (24 h), `week` (7 d) or `month` (30 d) that
 * starts when the binding is created and, once it is over, starts again at the next spend or
 * check. [proposta] Fixed windows, not the calendar, so the same code runs with a fake clock.
 */
export const WORKFLOW_BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type WorkflowBudgetPeriod = (typeof WORKFLOW_BUDGET_PERIODS)[number];

export const WORKFLOW_BUDGET_PERIOD_MS: Readonly<Record<WorkflowBudgetPeriod, number>> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** Binding ids are `WB<n>`, numbered across the whole store from 1. */
export const WORKFLOW_BINDING_ID_PATTERN = /^WB[1-9][0-9]*$/;

/**
 * The versions a binding accepts: `*` (the active version of the library, the default), an exact
 * version (`1.2.3`), or a range with `x` (`1.x`, `1.2.x`). [proposta]
 */
export const WORKFLOW_VERSION_RANGE_PATTERN =
  /^(\*|(0|[1-9]\d*)\.x|(0|[1-9]\d*)\.(0|[1-9]\d*)\.x|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?)$/;

const budgetUsd = z.number().positive();

/** One row of `workflow_bindings`. */
export const WorkflowBindingRecordSchema = z.strictObject({
  /** `WB<n>`, assigned by the store. */
  id: z.string().regex(WORKFLOW_BINDING_ID_PATTERN),
  seq: z.int().min(1),
  scenarioId: RecordIdSchema,
  workflowId,
  versionRange: z.string().regex(WORKFLOW_VERSION_RANGE_PATTERN),
  /** The values of the `inputs` of the workflow that this binding fixes. */
  params: JsonObjectSchema,
  /**
   * The triggers the binding asks for (P6 defines their shape: a type, the event name, the
   * filters). Opaque here.
   */
  triggers: z.array(JsonObjectSchema),
  state: z.enum(WORKFLOW_BINDING_STATES),
  /** Why it is `paused`, `stopped` or `expired`; null while `active`. */
  stateReason: z.enum(WORKFLOW_BINDING_REASONS).nullable(),
  /** The deadline (epoch ms); null is no deadline. */
  until: EpochMsSchema.nullable(),
  /** The budget of one period, in USD; null is no budget. */
  budgetUsd: budgetUsd.nullable(),
  budgetPeriod: z.enum(WORKFLOW_BUDGET_PERIODS),
  /** What was spent in the current period. */
  spentUsd: z.number().min(0),
  /** When the current period started. */
  periodStartedAt: EpochMsSchema,
  /** How many runs of the binding may be live at the same time. */
  concurrency: z.int().min(1).max(100),
  onBusy: z.enum(WORKFLOW_ON_BUSY),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** When `state` last changed. */
  stateChangedAt: EpochMsSchema,
});
export type WorkflowBindingRecord = z.infer<typeof WorkflowBindingRecordSchema>;

/** What a caller writes; the store assigns `id`, `seq`, the state (`active`) and the dates. */
export const NewWorkflowBindingSchema = z.strictObject({
  scenarioId: RecordIdSchema,
  workflowId,
  versionRange: z.string().regex(WORKFLOW_VERSION_RANGE_PATTERN).optional(),
  params: JsonObjectSchema.optional(),
  triggers: z.array(JsonObjectSchema).optional(),
  until: EpochMsSchema.nullable().optional(),
  budgetUsd: budgetUsd.nullable().optional(),
  budgetPeriod: z.enum(WORKFLOW_BUDGET_PERIODS).optional(),
  concurrency: z.int().min(1).max(100).optional(),
  onBusy: z.enum(WORKFLOW_ON_BUSY).optional(),
});
export type NewWorkflowBinding = z.infer<typeof NewWorkflowBindingSchema>;

/** The fields of a live binding that may change; the state moves only by `transition`. */
export const WorkflowBindingPatchSchema = NewWorkflowBindingSchema.omit({
  scenarioId: true,
  workflowId: true,
});
export type WorkflowBindingPatch = z.infer<typeof WorkflowBindingPatchSchema>;

/** A move of the state machine of a binding. */
export const WorkflowBindingTransitionSchema = z.strictObject({
  to: z.enum(WORKFLOW_BINDING_STATES),
  /**
   * `paused` and `stopped` need `producer` or `budget`; `expired` takes `deadline` (the default);
   * `active` takes none.
   */
  reason: z.enum(WORKFLOW_BINDING_REASONS).optional(),
});
export type WorkflowBindingTransition = z.infer<typeof WorkflowBindingTransitionSchema>;

export interface WorkflowBindingListFilter {
  readonly scenarioId?: string;
  readonly workflowId?: string;
  /** Only bindings in one of these states. Omitted means all. */
  readonly states?: readonly WorkflowBindingState[];
}

/** True when the budget of the current period is used up. */
export function workflowBudgetExhausted(
  binding: Pick<WorkflowBindingRecord, 'budgetUsd' | 'spentUsd'>,
): boolean {
  return binding.budgetUsd !== null && binding.spentUsd >= binding.budgetUsd;
}

/**
 * The bindings, part of `Store` (`store.workflowBindings`). Contract
 * (`describeWorkflowAggregatesConformance`):
 * - `create` validates (`InvalidInput`), assigns `WB<n>` and stores the binding `active` with
 *   `versionRange` `*`, `concurrency` 1, `onBusy` `queue` and `budgetPeriod` `day` unless given
 *   (the daemon passes the defaults of the configuration). A `until` that is not in the future
 *   is `InvalidInput`. A scenario has at most one live (`active` or `paused`) binding per
 *   workflow: another one is a `Conflict`.
 * - `get` and `list`; `list` is ordered by `seq`.
 * - `update(id, patch)`: `NotFound` for an unknown id, `InvalidInput` for a bad patch,
 *   `Conflict` for a binding that is `stopped` or `expired`.
 * - `transition(id, move)`, the state machine:
 *   - `active -> paused` (reason `producer` or `budget`), `paused -> active` (the reason is
 *     cleared), `active` or `paused -> stopped` (reason `producer` or `budget`), and
 *     `active` or `paused -> expired` (reason `deadline`, and only once `until` has passed);
 *   - `stopped` and `expired` are final; any other move is a `Conflict`, and a move without
 *     the reason it needs is `InvalidInput`;
 *   - resuming is a `Conflict` while the deadline has passed or the budget of the period is
 *     still used up (the period is renewed first, so a new period frees it).
 * - `recordSpend(id, usd)` adds to `spentUsd` of the current period (a period that is over
 *   starts again from zero first) and resolves with the record, whatever the state: money
 *   spent is a fact. It does not move the state; the daemon decides what an exhausted budget
 *   does (`workflows.budget.on_exhausted`).
 * - `rollPeriod(id)` starts a new period when the current one is over, and does nothing else.
 */
export interface WorkflowBindingRegistry {
  create(input: NewWorkflowBinding): Promise<WorkflowBindingRecord>;
  get(id: string): Promise<WorkflowBindingRecord | undefined>;
  list(filter?: WorkflowBindingListFilter): Promise<readonly WorkflowBindingRecord[]>;
  update(id: string, patch: WorkflowBindingPatch): Promise<WorkflowBindingRecord>;
  transition(id: string, move: WorkflowBindingTransition): Promise<WorkflowBindingRecord>;
  recordSpend(id: string, usd: number): Promise<WorkflowBindingRecord>;
  rollPeriod(id: string): Promise<WorkflowBindingRecord>;
}
