// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  NewQuotaSnapshotSchema,
  QuotaSnapshotRecordSchema,
  type NewQuotaSnapshot,
  type QuotaSnapshotListFilter,
  type QuotaSnapshotRecord,
  type QuotaSnapshotRegistry,
} from '../ports/quota-snapshots.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { eqTerms, inTerm, parseOrThrow } from './support.js';

export const QUOTA_SNAPSHOTS_SPEC: TableSpec<QuotaSnapshotRecord> = {
  name: 'quota_snapshots',
  schema: QuotaSnapshotRecordSchema,
  key: ['profileId', 'window'],
  json: [],
};

/** `QuotaSnapshotRegistry` over a {@link RecordTable}. */
export class TableQuotaSnapshotRegistry implements QuotaSnapshotRegistry {
  constructor(
    private readonly table: RecordTable<QuotaSnapshotRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async put(input: NewQuotaSnapshot): Promise<QuotaSnapshotRecord> {
    const given = parseOrThrow(NewQuotaSnapshotSchema, input, 'quota snapshot');
    const now = this.clock.now();
    const record: QuotaSnapshotRecord = {
      profileId: given.profileId,
      window: given.window,
      usedPercent: given.usedPercent,
      resetsAt: given.resetsAt ?? null,
      source: given.source,
      observedAt: given.observedAt ?? now,
      updatedAt: now,
    };
    const key = { profileId: record.profileId, window: record.window };
    if ((await this.table.get(key)) === undefined) await this.table.insert(record);
    else await this.table.replace(record);
    return record;
  }

  get(profileId: string, window: string): Promise<QuotaSnapshotRecord | undefined> {
    return this.table.get({ profileId, window });
  }

  list(filter: QuotaSnapshotListFilter = {}): Promise<readonly QuotaSnapshotRecord[]> {
    return this.table.select({
      eq: eqTerms({ profileId: filter.profileId }),
      in: inTerm('window', filter.windows),
      orderBy: [{ field: 'profileId' }, { field: 'window' }],
    });
  }
}
