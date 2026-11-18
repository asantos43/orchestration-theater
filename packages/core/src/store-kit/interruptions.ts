// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  InterruptionPatchSchema,
  InterruptionRecordSchema,
  NewInterruptionSchema,
  type InterruptionListFilter,
  type InterruptionPatch,
  type InterruptionRecord,
  type InterruptionRegistry,
  type NewInterruption,
} from '../ports/interruptions.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { nextSeq } from './sequence.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const INTERRUPTIONS_SPEC: TableSpec<InterruptionRecord> = {
  name: 'interruptions',
  schema: InterruptionRecordSchema,
  key: ['id'],
  json: ['signals'],
  boolean: ['countedAsAttempt'],
};

/** `InterruptionRegistry` over a {@link RecordTable}. */
export class TableInterruptionRegistry implements InterruptionRegistry {
  constructor(
    private readonly table: RecordTable<InterruptionRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewInterruption): Promise<InterruptionRecord> {
    const given = parseOrThrow(NewInterruptionSchema, input, 'interruption');
    const now = this.clock.now();
    const seq = await nextSeq(this.table);
    const record: InterruptionRecord = {
      id: `X${String(seq)}`,
      seq,
      sessionId: given.sessionId,
      playId: given.playId ?? null,
      cause: given.cause,
      signals: given.signals ?? [],
      resumeForm: given.resumeForm ?? null,
      fromExecutor: given.fromExecutor ?? null,
      toExecutor: given.toExecutor ?? null,
      countedAsAttempt: given.countedAsAttempt ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<InterruptionRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: InterruptionListFilter = {}): Promise<readonly InterruptionRecord[]> {
    return this.table.select({
      eq: eqTerms({ sessionId: filter.sessionId, playId: filter.playId }),
      in: inTerm('cause', filter.causes),
      orderBy: [{ field: 'seq' }],
    });
  }

  async update(id: string, patch: InterruptionPatch): Promise<InterruptionRecord> {
    const given = parseOrThrow(InterruptionPatchSchema, patch, 'interruption patch');
    const current = mustExist(await this.table.get({ id }), 'Interruption', id);
    const next: InterruptionRecord = {
      ...applyPatch(current, given),
      updatedAt: this.clock.now(),
    };
    await this.table.replace(next);
    return next;
  }
}
