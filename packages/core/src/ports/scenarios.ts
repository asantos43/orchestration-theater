// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, JsonObjectSchema, RecordIdSchema } from './store-schemas.js';

/** Kinds of scenario (architecture 5.20). The registry of scenario types lives elsewhere. */
export const SCENARIO_RECORD_KINDS = ['project', 'task', 'chat'] as const;
export type ScenarioRecordKind = (typeof SCENARIO_RECORD_KINDS)[number];

/** State of the Director of a scenario (architecture 5.20, "Diretor adormecido"). */
export const DIRECTOR_STATES = ['active', 'asleep'] as const;
export type DirectorState = (typeof DIRECTOR_STATES)[number];

export const SCENARIO_STATES = ['active', 'archived'] as const;
export type ScenarioState = (typeof SCENARIO_STATES)[number];

const text = z.string().min(1);

/** One row of `scenarios` (architecture section 7). */
export const ScenarioRecordSchema = z.strictObject({
  id: RecordIdSchema,
  kind: z.enum(SCENARIO_RECORD_KINDS),
  /** Id of the default flow in the flow registry (5.18). */
  flowId: text,
  name: text,
  folder: text,
  /** Project profile (`software`...), only for a project. */
  profile: text.nullable(),
  /** Conventions detected in an imported repository (5.20), only for a project. */
  conventions: JsonObjectSchema.nullable(),
  baseBranch: text.nullable(),
  /** Configuration keys overridden for this scenario only. */
  configOverride: JsonObjectSchema,
  /** Scenario this one was promoted from (a chat that became a project, say). */
  originScenarioId: RecordIdSchema.nullable(),
  directorState: z.enum(DIRECTOR_STATES),
  state: z.enum(SCENARIO_STATES),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type ScenarioRecord = z.infer<typeof ScenarioRecordSchema>;

/** What a caller writes: the store stamps `createdAt` and `updatedAt`; the rest defaults. */
export const NewScenarioSchema = ScenarioRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
}).partial({
  profile: true,
  conventions: true,
  baseBranch: true,
  configOverride: true,
  originScenarioId: true,
  directorState: true,
  state: true,
});
export type NewScenario = z.infer<typeof NewScenarioSchema>;

/** The fields of a scenario that change after creation. */
export const ScenarioPatchSchema = ScenarioRecordSchema.pick({
  name: true,
  folder: true,
  profile: true,
  conventions: true,
  baseBranch: true,
  configOverride: true,
  directorState: true,
  state: true,
}).partial();
export type ScenarioPatch = z.infer<typeof ScenarioPatchSchema>;

export interface ScenarioListFilter {
  readonly kinds?: readonly ScenarioRecordKind[];
  readonly states?: readonly ScenarioState[];
}

/**
 * Registry of scenarios, part of `Store`. Contract (checked by `describeScenarioConformance`):
 * - `create` validates, stamps and stores the scenario; an existing id rejects with `Conflict`,
 *   an invalid input with `InvalidInput`. A project needs no more than the common fields.
 * - `get` resolves `undefined` for an unknown id. `list` is ordered by `createdAt`, then `id`.
 * - `update` changes only the fields of {@link ScenarioPatch}; an unknown id rejects with
 *   `NotFound`, an unknown field with `InvalidInput`. It bumps `updatedAt`.
 * - Inside a transaction, reads see its own writes; a rollback drops them.
 */
export interface ScenarioRegistry {
  create(input: NewScenario): Promise<ScenarioRecord>;
  get(id: string): Promise<ScenarioRecord | undefined>;
  list(filter?: ScenarioListFilter): Promise<readonly ScenarioRecord[]>;
  update(id: string, patch: ScenarioPatch): Promise<ScenarioRecord>;
}

/** One row of `scenario_repos`: a repository of a project (5.20; one per project in v1). */
export const ScenarioRepoRecordSchema = z.strictObject({
  scenarioId: RecordIdSchema,
  path: text,
  remote: text.nullable(),
  mainBranch: text,
  createdAt: EpochMsSchema,
});
export type ScenarioRepoRecord = z.infer<typeof ScenarioRepoRecordSchema>;

export const NewScenarioRepoSchema = ScenarioRepoRecordSchema.omit({ createdAt: true }).partial({
  remote: true,
});
export type NewScenarioRepo = z.infer<typeof NewScenarioRepoSchema>;

/**
 * Repositories of a scenario. `put` inserts or replaces by `(scenarioId, path)` and keeps
 * `createdAt`; `list` is ordered by `createdAt`, then `path`; `remove` resolves `true` when a
 * repository was removed.
 */
export interface ScenarioRepoRegistry {
  put(input: NewScenarioRepo): Promise<ScenarioRepoRecord>;
  get(scenarioId: string, path: string): Promise<ScenarioRepoRecord | undefined>;
  list(scenarioId: string): Promise<readonly ScenarioRepoRecord[]>;
  remove(scenarioId: string, path: string): Promise<boolean>;
}

/** Where an attachment lives: a copy in the scenario folder, or a read-only reference. */
export const ATTACHMENT_SOURCES = ['copy', 'reference'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

/** Attachment ids are `A<n>`, numbered per scenario from 1. */
export const ATTACHMENT_ID_PATTERN = /^A[1-9][0-9]*$/;

/** One row of `attachments` (architecture 5.20). */
export const AttachmentRecordSchema = z.strictObject({
  scenarioId: RecordIdSchema,
  /** `A<n>`, assigned by the store. */
  id: z.string().regex(ATTACHMENT_ID_PATTERN),
  /** The `n` of the id. */
  seq: z.int().min(1),
  /** Chat message the attachment came with, if any. */
  messageId: RecordIdSchema.nullable(),
  name: text,
  mime: text,
  /** Size in bytes. */
  size: z.int().min(0),
  hash: text,
  source: z.enum(ATTACHMENT_SOURCES),
  /** The copy in the scenario folder, or the referenced path. */
  path: text,
  createdAt: EpochMsSchema,
});
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>;

export const NewAttachmentSchema = AttachmentRecordSchema.omit({
  id: true,
  seq: true,
  createdAt: true,
}).partial({ messageId: true });
export type NewAttachment = z.infer<typeof NewAttachmentSchema>;

/**
 * Attachments of a scenario. `add` assigns the next `A<n>` of that scenario (1, 2, 3...; the
 * numbers of two scenarios are independent). `list` is ordered by `seq`.
 */
export interface AttachmentRegistry {
  add(input: NewAttachment): Promise<AttachmentRecord>;
  get(scenarioId: string, id: string): Promise<AttachmentRecord | undefined>;
  list(scenarioId: string): Promise<readonly AttachmentRecord[]>;
}
