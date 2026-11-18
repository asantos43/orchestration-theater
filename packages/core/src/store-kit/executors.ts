// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  ExecutorPatchSchema,
  ExecutorRecordSchema,
  NewExecutorSchema,
  formatExecutorId,
  type ExecutorListFilter,
  type ExecutorPatch,
  type ExecutorRecord,
  type ExecutorRegistry,
  type NewExecutor,
} from '../ports/executor-records.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { eqTerms, mustExist, parseOrThrow } from './support.js';

export const EXECUTORS_SPEC: TableSpec<ExecutorRecord> = {
  name: 'executors',
  schema: ExecutorRecordSchema,
  key: ['id'],
  json: [],
};

/** `ExecutorRegistry` over a {@link RecordTable}. */
export class TableExecutorRegistry implements ExecutorRegistry {
  constructor(
    private readonly table: RecordTable<ExecutorRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewExecutor): Promise<ExecutorRecord> {
    const given = parseOrThrow(NewExecutorSchema, input, 'executor');
    const now = this.clock.now();
    const record: ExecutorRecord = {
      id: formatExecutorId(given),
      profileId: given.profileId,
      model: given.model,
      effort: given.effort,
      provider: given.provider,
      validity: 'valid',
      invalidReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<ExecutorRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: ExecutorListFilter = {}): Promise<readonly ExecutorRecord[]> {
    return this.table.select({
      eq: eqTerms({
        profileId: filter.profileId,
        provider: filter.provider,
        validity: filter.validity,
      }),
      orderBy: [{ field: 'id' }],
    });
  }

  async update(id: string, patch: ExecutorPatch): Promise<ExecutorRecord> {
    const given = parseOrThrow(ExecutorPatchSchema, patch, 'executor patch');
    const current = mustExist(await this.table.get({ id }), 'Executor', id);
    const validity = given.validity ?? current.validity;
    const next: ExecutorRecord = {
      ...current,
      provider: given.provider ?? current.provider,
      validity,
      invalidReason: validity === 'valid' ? null : (given.invalidReason ?? current.invalidReason),
      updatedAt: this.clock.now(),
    };
    await this.table.replace(next);
    return next;
  }
}
