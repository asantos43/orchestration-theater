// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewPromptQueueItemSchema,
  PROMPT_PRIORITY,
  PromptQueueItemSchema,
  type NewPromptQueueItem,
  type PromptQueue,
  type PromptQueueFilter,
  type PromptQueueItem,
} from '../ports/prompt-queue.js';
import type { OrderTerm, RecordTable, TableSpec } from './record-table.js';
import { eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const PROMPT_QUEUE_SPEC: TableSpec<PromptQueueItem> = {
  name: 'prompt_queue',
  schema: PromptQueueItemSchema,
  key: ['id'],
  json: ['content'],
};

/** Delivery order: higher priority first, then arrival. */
const DELIVERY_ORDER: readonly OrderTerm[] = [{ field: 'priority', desc: true }, { field: 'seq' }];

/** `PromptQueue` over a {@link RecordTable}. */
export class TablePromptQueue implements PromptQueue {
  constructor(
    private readonly table: RecordTable<PromptQueueItem>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async enqueue(input: NewPromptQueueItem): Promise<PromptQueueItem> {
    const given = parseOrThrow(NewPromptQueueItemSchema, input, 'prompt');
    const [last] = await this.table.select({ orderBy: [{ field: 'seq', desc: true }], limit: 1 });
    const item: PromptQueueItem = {
      id: given.id,
      seq: (last?.seq ?? 0) + 1,
      scenarioId: given.scenarioId,
      source: given.source,
      priority: given.priority ?? PROMPT_PRIORITY[given.source],
      content: given.content,
      state: 'pending',
      createdAt: this.clock.now(),
      deliveredAt: null,
    };
    await this.table.insert(item);
    return item;
  }

  get(id: string): Promise<PromptQueueItem | undefined> {
    return this.table.get({ id });
  }

  list(filter: PromptQueueFilter = {}): Promise<readonly PromptQueueItem[]> {
    return this.table.select({
      eq: eqTerms({ scenarioId: filter.scenarioId }),
      in: inTerm('state', filter.states),
      orderBy: DELIVERY_ORDER,
    });
  }

  async next(scenarioId?: string): Promise<PromptQueueItem | undefined> {
    const [first] = await this.table.select({
      eq: eqTerms({ scenarioId, state: 'pending' }),
      orderBy: DELIVERY_ORDER,
      limit: 1,
    });
    return first;
  }

  async markDelivered(id: string): Promise<PromptQueueItem> {
    const current = mustExist(await this.table.get({ id }), 'Prompt', id);
    if (current.state !== 'pending') throw new Conflict(`Prompt ${id} was already delivered`);
    const next: PromptQueueItem = { ...current, state: 'delivered', deliveredAt: this.clock.now() };
    await this.table.replace(next);
    return next;
  }
}
