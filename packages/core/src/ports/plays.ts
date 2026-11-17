// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { JsonValueSchema } from './event-log.js';
import { EpochMsSchema, JsonObjectSchema, RecordIdSchema } from './store-schemas.js';

const text = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// plays
// ---------------------------------------------------------------------------------------------

/** One row of `plays` (architecture section 7 and 5.4). */
export const PlayRecordSchema = z.strictObject({
  id: RecordIdSchema,
  scenarioId: RecordIdSchema,
  /** The need the Producer stated (the input of the play). */
  need: text,
  /** Id and version of the flow in the flow registry (5.18). A snapshot is only restored on the same version. */
  flowId: text,
  flowVersion: z.int().min(1),
  /** Name of the current state of the machine (`PLANNING`, `AWAITING_PRODUCER`...). */
  state: text,
  /** `getPersistedSnapshot()` of the XState actor; null before the first transition. */
  snapshot: JsonObjectSchema.nullable(),
  /** Loop counters of the play (`plan_reviews`, `structural_restarts`...), by name. */
  counters: z.record(z.string(), z.int().min(0)),
  /** Play this one follows (a change request after delivery opens a linked play; 5.4). */
  parentPlayId: RecordIdSchema.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** Set when the play reached a final state; null while it is open. */
  finishedAt: EpochMsSchema.nullable(),
});
export type PlayRecord = z.infer<typeof PlayRecordSchema>;

export const NewPlaySchema = PlayRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
}).partial({ snapshot: true, counters: true, parentPlayId: true });
export type NewPlay = z.infer<typeof NewPlaySchema>;

/** The fields of a play that change: its state, snapshot and counters move together (5.4). */
export const PlayPatchSchema = PlayRecordSchema.pick({
  state: true,
  snapshot: true,
  counters: true,
  finishedAt: true,
}).partial();
export type PlayPatch = z.infer<typeof PlayPatchSchema>;

export interface PlayListFilter {
  readonly scenarioId?: string;
  /** Only plays in one of these states. Omitted means all. */
  readonly states?: readonly string[];
  /** `true`: only plays not finished; `false`: only finished plays. Omitted means all. */
  readonly open?: boolean;
}

/**
 * Registry of plays, part of `Store`. The daemon writes the snapshot with `update`, in the same
 * transaction as the event of the transition and before the effect it triggers (5.21).
 * Contract (`describePlayConformance`): `create` stamps and stores (`Conflict` on an existing id,
 * `InvalidInput` on a bad input); `update` bumps `updatedAt` (`NotFound` for an unknown id,
 * `InvalidInput` for a field outside {@link PlayPatch}); `list` is ordered by `createdAt`, then
 * `id`; inside a transaction reads see its writes and a rollback drops them.
 */
export interface PlayRegistry {
  create(input: NewPlay): Promise<PlayRecord>;
  get(id: string): Promise<PlayRecord | undefined>;
  list(filter?: PlayListFilter): Promise<readonly PlayRecord[]>;
  update(id: string, patch: PlayPatch): Promise<PlayRecord>;
}

// ---------------------------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------------------------

/** [proposta] Lifecycle of one stage execution. */
export const STAGE_STATES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** One row of `stages`: a stage executed by a play (role, attempt, result). */
export const StageRecordSchema = z.strictObject({
  id: RecordIdSchema,
  playId: RecordIdSchema,
  /** Name of the stage in the flow (`PLANNING`, `EXECUTING`...). */
  name: text,
  role: text,
  attemptId: RecordIdSchema.nullable(),
  demandId: RecordIdSchema.nullable(),
  state: z.enum(STAGE_STATES),
  /** Structured result (the `submit` of the role), when there is one. */
  result: JsonObjectSchema.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  endedAt: EpochMsSchema.nullable(),
});
export type StageRecord = z.infer<typeof StageRecordSchema>;

export const NewStageSchema = StageRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
  endedAt: true,
}).partial({ attemptId: true, demandId: true, state: true, result: true });
export type NewStage = z.infer<typeof NewStageSchema>;

export const StagePatchSchema = StageRecordSchema.pick({
  state: true,
  result: true,
  attemptId: true,
  endedAt: true,
}).partial();
export type StagePatch = z.infer<typeof StagePatchSchema>;

export interface StageListFilter {
  readonly playId?: string;
  readonly states?: readonly StageState[];
}

/**
 * Registry of stages. Same rules as {@link PlayRegistry}; `list` is ordered by `createdAt`, then
 * `id`. A stage born or updated to a state other than `running` gets `endedAt` (the moment it
 * ended) unless the update sets it.
 */
export interface StageRegistry {
  create(input: NewStage): Promise<StageRecord>;
  get(id: string): Promise<StageRecord | undefined>;
  list(filter?: StageListFilter): Promise<readonly StageRecord[]>;
  update(id: string, patch: StagePatch): Promise<StageRecord>;
}

// ---------------------------------------------------------------------------------------------
// demands
// ---------------------------------------------------------------------------------------------

/** [proposta] Lifecycle of a demand of the script. */
export const DEMAND_STATES = [
  'pending',
  'ready',
  'running',
  'in_review',
  'approved',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type DemandState = (typeof DEMAND_STATES)[number];

export const DEMAND_COMPLEXITIES = ['low', 'medium', 'high'] as const;

/**
 * One row of `demands`: the fields of `Demand` (architecture 5.4) plus its state. [proposta] The
 * store keeps `contract` references and `verify` steps as JSON, and the script validation (not
 * the store) says what is inside; the key is `(playId, id)` because ids come from the script.
 */
export const DemandRecordSchema = z.strictObject({
  playId: RecordIdSchema,
  id: RecordIdSchema,
  title: text,
  description: z.string(),
  dependsOn: z.array(RecordIdSchema),
  contract: z.strictObject({
    inputs: z.array(JsonValueSchema),
    outputs: z.array(JsonValueSchema),
  }),
  expectedFiles: z.array(text),
  complexity: z.enum(DEMAND_COMPLEXITIES),
  specialty: text.nullable(),
  timeoutMin: z.int().min(1),
  acceptanceCriteria: z.array(text),
  verify: z.array(JsonValueSchema),
  verifyWaiver: text.nullable(),
  state: z.enum(DEMAND_STATES),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type DemandRecord = z.infer<typeof DemandRecordSchema>;

export const NewDemandSchema = DemandRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
}).partial({ specialty: true, verifyWaiver: true, state: true });
export type NewDemand = z.infer<typeof NewDemandSchema>;

export const DemandPatchSchema = DemandRecordSchema.pick({ state: true }).partial();
export type DemandPatch = z.infer<typeof DemandPatchSchema>;

export interface DemandListFilter {
  readonly playId?: string;
  readonly states?: readonly DemandState[];
}

/**
 * Registry of demands. `list` is ordered by `createdAt`, then `playId` and `id`. Only the state
 * changes after creation.
 */
export interface DemandRegistry {
  create(input: NewDemand): Promise<DemandRecord>;
  get(playId: string, id: string): Promise<DemandRecord | undefined>;
  list(filter?: DemandListFilter): Promise<readonly DemandRecord[]>;
  update(playId: string, id: string, patch: DemandPatch): Promise<DemandRecord>;
}

// ---------------------------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------------------------

export const DECISION_STATES = ['pending', 'decided', 'cancelled'] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/** Who settled a judgment point. [proposta] */
export const DECIDERS = ['producer', 'director', 'daemon'] as const;
export type Decider = (typeof DECIDERS)[number];

/** One row of `decisions`: a judgment point (5.4) with its input, answer and decider. */
export const DecisionRecordSchema = z.strictObject({
  id: RecordIdSchema,
  scenarioId: RecordIdSchema,
  playId: RecordIdSchema.nullable(),
  /** Type of the judgment point (`script_review`, `dispense_critic`...). */
  kind: text,
  input: JsonObjectSchema,
  answer: JsonObjectSchema.nullable(),
  decidedBy: z.enum(DECIDERS).nullable(),
  state: z.enum(DECISION_STATES),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  decidedAt: EpochMsSchema.nullable(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const NewDecisionSchema = DecisionRecordSchema.omit({
  answer: true,
  decidedBy: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  decidedAt: true,
}).partial({ playId: true });
export type NewDecision = z.infer<typeof NewDecisionSchema>;

export const DecisionAnswerSchema = z.strictObject({
  answer: JsonObjectSchema,
  decidedBy: z.enum(DECIDERS),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export interface DecisionListFilter {
  readonly scenarioId?: string;
  readonly playId?: string;
  readonly kinds?: readonly string[];
  readonly states?: readonly DecisionState[];
}

/**
 * Registry of decisions. A decision is born `pending`; `decide` records the answer and the
 * decider once (`Conflict` when it is no longer pending); `cancel` ends a pending one. `list` is
 * ordered by `createdAt`, then `id`.
 */
export interface DecisionRegistry {
  create(input: NewDecision): Promise<DecisionRecord>;
  get(id: string): Promise<DecisionRecord | undefined>;
  list(filter?: DecisionListFilter): Promise<readonly DecisionRecord[]>;
  decide(id: string, answer: DecisionAnswer): Promise<DecisionRecord>;
  cancel(id: string): Promise<DecisionRecord>;
}
