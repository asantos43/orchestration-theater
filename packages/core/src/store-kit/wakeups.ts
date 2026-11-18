// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewWakeupSchema,
  WakeupPatchSchema,
  WakeupRecordSchema,
  type NewWakeup,
  type WakeupListFilter,
  type WakeupPatch,
  type WakeupRecord,
  type WakeupRegistry,
} from '../ports/wakeups.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { nextSeq } from './sequence.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const WAKEUPS_SPEC: TableSpec<WakeupRecord> = {
  name: 'wakeups',
  schema: WakeupRecordSchema,
  key: ['id'],
  json: [],
};

/** `WakeupRegistry` over a {@link RecordTable}. */
export class TableWakeupRegistry implements WakeupRegistry {
  constructor(
    private readonly table: RecordTable<WakeupRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewWakeup): Promise<WakeupRecord> {
    const given = parseOrThrow(NewWakeupSchema, input, 'wakeup');
    const [existing] = await this.table.select({
      eq: { profileId: given.profileId, cause: given.cause, state: 'scheduled' },
      orderBy: [{ field: 'seq' }],
      limit: 1,
    });
    if (existing !== undefined) {
      throw new Conflict(
        `Profile ${given.profileId} already has the wakeup ${existing.id} scheduled for ${given.cause}`,
      );
    }
    const now = this.clock.now();
    const seq = await nextSeq(this.table);
    const record: WakeupRecord = {
      id: `W${String(seq)}`,
      seq,
      profileId: given.profileId,
      cause: given.cause,
      at: given.at,
      state: 'scheduled',
      osTriggerId: given.osTriggerId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<WakeupRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: WakeupListFilter = {}): Promise<readonly WakeupRecord[]> {
    return this.table.select({
      eq: eqTerms({ profileId: filter.profileId, cause: filter.cause }),
      in: inTerm('state', filter.states),
      ranges: filter.dueBy === undefined ? {} : { at: { lte: filter.dueBy } },
      orderBy: [{ field: 'at' }, { field: 'seq' }],
    });
  }

  async update(id: string, patch: WakeupPatch): Promise<WakeupRecord> {
    const given = parseOrThrow(WakeupPatchSchema, patch, 'wakeup patch');
    const current = mustExist(await this.table.get({ id }), 'Wakeup', id);
    if (current.state !== 'scheduled') {
      throw new Conflict(`Wakeup ${id} is already ${current.state}`);
    }
    const next: WakeupRecord = { ...applyPatch(current, given), updatedAt: this.clock.now() };
    await this.table.replace(next);
    return next;
  }
}
