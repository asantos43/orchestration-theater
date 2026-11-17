// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, JsonObjectSchema, RecordIdSchema } from './store-schemas.js';

/** Who put a prompt in the queue. [proposta] */
export const PROMPT_SOURCES = ['producer', 'director', 'daemon', 'schedule'] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

/**
 * [proposta] Default priority of each source: the Producer goes first (architecture 5.4), then
 * the Director's own follow-ups, then what the daemon and the schedules generate. A caller may
 * pass any integer; a higher number is delivered first.
 */
export const PROMPT_PRIORITY: Readonly<Record<PromptSource, number>> = {
  producer: 100,
  director: 50,
  schedule: 10,
  daemon: 0,
};

export const PROMPT_STATES = ['pending', 'delivered'] as const;
export type PromptState = (typeof PROMPT_STATES)[number];

/** One row of `prompt_queue`: the single queue of prompts of the Director (5.4). */
export const PromptQueueItemSchema = z.strictObject({
  id: RecordIdSchema,
  /** Arrival order across the whole queue, assigned by the store (1, 2, 3...). */
  seq: z.int().min(1),
  scenarioId: RecordIdSchema,
  source: z.enum(PROMPT_SOURCES),
  priority: z.int(),
  /** The prompt: at least `text`; the rest is up to the producer of the item. */
  content: JsonObjectSchema,
  state: z.enum(PROMPT_STATES),
  createdAt: EpochMsSchema,
  deliveredAt: EpochMsSchema.nullable(),
});
export type PromptQueueItem = z.infer<typeof PromptQueueItemSchema>;

export const NewPromptQueueItemSchema = PromptQueueItemSchema.omit({
  seq: true,
  state: true,
  createdAt: true,
  deliveredAt: true,
}).partial({ priority: true });
export type NewPromptQueueItem = z.infer<typeof NewPromptQueueItemSchema>;

export interface PromptQueueFilter {
  readonly scenarioId?: string;
  readonly states?: readonly PromptState[];
}

/**
 * The prompt queue, part of `Store`. Contract (`describePromptQueueConformance`):
 * - `enqueue` writes the item as `pending` before anything is delivered (5.21), so a prompt in
 *   the queue survives a restart; an existing id rejects with `Conflict`. The priority defaults
 *   to {@link PROMPT_PRIORITY} of the source.
 * - `list` and `next` use the delivery order: higher priority first, then arrival (`seq`).
 * - `next` resolves the first pending item (of a scenario, when given) or `undefined`.
 * - `markDelivered` moves a pending item to `delivered` and stamps `deliveredAt`; an unknown id
 *   rejects with `NotFound`, an item already delivered with `Conflict`.
 */
export interface PromptQueue {
  enqueue(input: NewPromptQueueItem): Promise<PromptQueueItem>;
  get(id: string): Promise<PromptQueueItem | undefined>;
  list(filter?: PromptQueueFilter): Promise<readonly PromptQueueItem[]>;
  next(scenarioId?: string): Promise<PromptQueueItem | undefined>;
  markDelivered(id: string): Promise<PromptQueueItem>;
}
