// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewUsageSchema,
  UsagePatchSchema,
  UsageRecordSchema,
  type NewUsage,
  type UsageCost,
  type UsageListFilter,
  type UsagePatch,
  type UsageRecord,
  type UsageRegistry,
} from '../ports/usage.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { nextSeq } from './sequence.js';
import { eqTerms, mustExist, parseOrThrow } from './support.js';

export const USAGE_SPEC: TableSpec<UsageRecord> = {
  name: 'usage',
  schema: UsageRecordSchema,
  key: ['id'],
  json: [],
};

type CostColumns = Pick<UsageRecord, 'costUsd' | 'costKind' | 'costSource' | 'pricingVersion'>;

/** The cost columns of a cost; a cost priced by table must say which version of the table. */
function costColumns(cost: UsageCost | undefined): CostColumns {
  if (cost === undefined) {
    return { costUsd: null, costKind: null, costSource: null, pricingVersion: null };
  }
  if (cost.source === 'pricing_table' && cost.pricingVersion === undefined) {
    throw new InvalidInput('A cost priced by pricing_table carries its pricingVersion');
  }
  return {
    costUsd: cost.usd,
    costKind: cost.kind,
    costSource: cost.source,
    pricingVersion: cost.pricingVersion ?? null,
  };
}

/** `UsageRegistry` over a {@link RecordTable}. */
export class TableUsageRegistry implements UsageRegistry {
  constructor(
    private readonly table: RecordTable<UsageRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async record(input: NewUsage): Promise<UsageRecord> {
    const given = parseOrThrow(NewUsageSchema, input, 'usage');
    const now = this.clock.now();
    const seq = await nextSeq(this.table);
    const record: UsageRecord = {
      id: `U${String(seq)}`,
      seq,
      sessionId: given.sessionId,
      playId: given.playId ?? null,
      profileId: given.profileId,
      executorId: given.executorId,
      model: given.model,
      inputTokens: given.inputTokens ?? null,
      outputTokens: given.outputTokens ?? null,
      cachedTokens: given.cachedTokens ?? null,
      ...costColumns(given.cost),
      occurredAt: given.occurredAt ?? now,
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<UsageRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: UsageListFilter = {}): Promise<readonly UsageRecord[]> {
    const bounds = {
      ...(filter.since === undefined ? {} : { gte: filter.since }),
      ...(filter.until === undefined ? {} : { lte: filter.until }),
    };
    return this.table.select({
      eq: eqTerms({
        sessionId: filter.sessionId,
        playId: filter.playId,
        profileId: filter.profileId,
        executorId: filter.executorId,
      }),
      ranges: Object.keys(bounds).length === 0 ? {} : { occurredAt: bounds },
      orderBy: [{ field: 'occurredAt' }, { field: 'seq' }],
    });
  }

  async update(id: string, patch: UsagePatch): Promise<UsageRecord> {
    const given = parseOrThrow(UsagePatchSchema, patch, 'usage patch');
    const current = mustExist(await this.table.get({ id }), 'Usage', id);
    const next: UsageRecord = {
      ...current,
      inputTokens: given.inputTokens ?? current.inputTokens,
      outputTokens: given.outputTokens ?? current.outputTokens,
      cachedTokens: given.cachedTokens ?? current.cachedTokens,
      ...(given.cost === undefined ? {} : costColumns(given.cost)),
      updatedAt: this.clock.now(),
    };
    await this.table.replace(next);
    return next;
  }
}
