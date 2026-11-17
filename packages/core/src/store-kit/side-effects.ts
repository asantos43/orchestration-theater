// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewSideEffectSchema,
  SideEffectRecordSchema,
  SideEffectResolutionInputSchema,
  type NewSideEffect,
  type SideEffectListFilter,
  type SideEffectRecord,
  type SideEffectRegistry,
  type SideEffectResolutionInput,
} from '../ports/side-effects.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const SIDE_EFFECTS_SPEC: TableSpec<SideEffectRecord> = {
  name: 'side_effects',
  schema: SideEffectRecordSchema,
  key: ['idempotencyKey'],
  json: ['params', 'result'],
};

/** `SideEffectRegistry` over a {@link RecordTable}. */
export class TableSideEffectRegistry implements SideEffectRegistry {
  constructor(
    private readonly table: RecordTable<SideEffectRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async intend(input: NewSideEffect): Promise<SideEffectRecord> {
    const given = parseOrThrow(NewSideEffectSchema, input, 'side effect');
    const now = this.clock.now();
    const record: SideEffectRecord = {
      idempotencyKey: given.idempotencyKey,
      type: given.type,
      target: given.target,
      attemptId: given.attemptId ?? null,
      params: given.params ?? null,
      result: null,
      state: 'pending',
      verifier: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(idempotencyKey: string): Promise<SideEffectRecord | undefined> {
    return this.table.get({ idempotencyKey });
  }

  list(filter: SideEffectListFilter = {}): Promise<readonly SideEffectRecord[]> {
    return this.table.select({
      eq: eqTerms({ attemptId: filter.attemptId }),
      in: { ...inTerm('state', filter.states), ...inTerm('type', filter.types) },
      orderBy: [{ field: 'createdAt' }, { field: 'idempotencyKey' }],
    });
  }

  async resolve(
    idempotencyKey: string,
    resolution: SideEffectResolutionInput,
  ): Promise<SideEffectRecord> {
    const given = parseOrThrow(SideEffectResolutionInputSchema, resolution, 'resolution');
    const current = mustExist(
      await this.table.get({ idempotencyKey }),
      'Side effect',
      idempotencyKey,
    );
    if (current.state !== 'pending' && current.state !== 'ambiguous') {
      throw new Conflict(`Side effect ${idempotencyKey} is already ${current.state}`);
    }
    const now = this.clock.now();
    const next: SideEffectRecord = {
      ...current,
      state: given.state,
      result: given.result ?? current.result,
      verifier: given.verifier ?? current.verifier,
      updatedAt: now,
      resolvedAt: given.state === 'ambiguous' ? null : now,
    };
    await this.table.replace(next);
    return next;
  }
}
