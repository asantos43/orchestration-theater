// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

/**
 * The idea queue of a scenario (architecture 5.20, decision N91): ideas that wait to be grouped
 * by the Author into the need of a play. [proposta] The fields below.
 */

/**
 * Lifecycle of an idea:
 * `queued` waits for a grouping; `grouped` was put in a group (the group waits for the
 * approval of the Producer, or its play is running); `done` was delivered by its play;
 * `discarded` and `deferred` were left out on purpose and always carry a reason.
 */
export const IDEA_STATES = ['queued', 'grouped', 'done', 'discarded', 'deferred'] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

/** Where an idea came from. `import` is reserved for the import of the `okit` demands (N92). */
export const IDEA_SOURCES = ['chat', 'tui', 'terminal', 'author', 'import'] as const;
export type IdeaSource = (typeof IDEA_SOURCES)[number];

/** The states an idea can go to from each state (`done` and `discarded` are final). `grouped` to
 * `grouped` gives the idea the play its group opened. */
export const IDEA_TRANSITIONS: Readonly<Record<IdeaState, readonly IdeaState[]>> = {
  queued: ['grouped', 'discarded', 'deferred'],
  grouped: ['grouped', 'queued', 'done', 'discarded', 'deferred'],
  done: [],
  discarded: [],
  deferred: ['queued', 'discarded'],
};

/** Idea ids are `I<n>`, numbered across the whole store from 1. */
export const IDEA_ID_PATTERN = /^I[1-9][0-9]*$/;

const text = z.string().min(1);

/** One row of `ideas`. */
export const IdeaRecordSchema = z.strictObject({
  /** `I<n>`, assigned by the store. */
  id: z.string().regex(IDEA_ID_PATTERN),
  /** The `n` of the id: the arrival order. */
  seq: z.int().min(1),
  scenarioId: RecordIdSchema,
  /** What the Producer wants, in their words. */
  text,
  /** A free hint of the area of the codebase it touches; the Author uses it to group. */
  area: text.nullable(),
  source: z.enum(IDEA_SOURCES),
  state: z.enum(IDEA_STATES),
  /** The group the idea was put in; ideas of one group share it. Null while `queued`. */
  groupId: text.nullable(),
  /** Position of the idea in its group (the Author's order), from 1. */
  groupOrder: z.int().min(1).nullable(),
  /** The play that carries the idea out. Null until the group is approved. */
  playId: RecordIdSchema.nullable(),
  /** The pull request that delivered it (set with `done`, when the play opened one). */
  prNumber: z.int().min(1).nullable(),
  prUrl: text.nullable(),
  /** Why it was discarded or deferred, or why it went back to the queue. */
  reason: text.nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** Set when the idea reached `done` or `discarded`. */
  closedAt: EpochMsSchema.nullable(),
});
export type IdeaRecord = z.infer<typeof IdeaRecordSchema>;

/** What a caller writes; the store assigns `id` and `seq`, the state (`queued`) and the dates. */
export const NewIdeaSchema = IdeaRecordSchema.pick({
  scenarioId: true,
  text: true,
  area: true,
  source: true,
}).partial({ area: true, source: true });
export type NewIdea = z.infer<typeof NewIdeaSchema>;

/** The pull request of a delivered idea. */
export const IdeaPullRequestSchema = z.strictObject({
  number: z.int().min(1),
  url: text,
});
export type IdeaPullRequest = z.infer<typeof IdeaPullRequestSchema>;

/** What goes with a state change; the rules per target state are at {@link IdeaRegistry}. */
export const IdeaTransitionSchema = z.strictObject({
  groupId: text.optional(),
  groupOrder: z.int().min(1).optional(),
  playId: RecordIdSchema.optional(),
  pullRequest: IdeaPullRequestSchema.optional(),
  reason: text.optional(),
});
export type IdeaTransition = z.infer<typeof IdeaTransitionSchema>;

export interface IdeaListFilter {
  readonly scenarioId?: string;
  /** Only ideas in one of these states. Omitted means all. */
  readonly states?: readonly IdeaState[];
  readonly playId?: string;
  readonly groupId?: string;
}

/**
 * Registry of ideas, part of `Store`. Contract (`describeIdeaConformance`):
 * - `create` validates, assigns `I<n>` (1, 2, 3... across the store) and stores the idea
 *   `queued`; `InvalidInput` for a bad input.
 * - `transition(id, to, patch)` moves an idea along {@link IDEA_TRANSITIONS} (`Conflict` for a
 *   move that is not listed, `NotFound` for an unknown id, `InvalidInput` for a bad patch):
 *   - to `grouped` it needs `groupId` and `groupOrder` (an idea already grouped keeps its own) and
 *     takes the `playId` of the group when it has one;
 *   - to `done` it needs a `playId` (its own, or the one the idea already has) and stores the
 *     `pullRequest` when there is one; `closedAt` is stamped;
 *   - to `discarded` and `deferred` it needs a `reason` (`discarded` also stamps `closedAt`);
 *   - to `queued` (the play was cancelled or ended without delivery, or a deferred idea came
 *     back) it clears the group, the play and the pull request and keeps the `reason`.
 * - `get` and `list`; `list` is ordered by `seq`.
 */
export interface IdeaRegistry {
  create(input: NewIdea): Promise<IdeaRecord>;
  get(id: string): Promise<IdeaRecord | undefined>;
  list(filter?: IdeaListFilter): Promise<readonly IdeaRecord[]>;
  transition(id: string, to: IdeaState, patch?: IdeaTransition): Promise<IdeaRecord>;
}
