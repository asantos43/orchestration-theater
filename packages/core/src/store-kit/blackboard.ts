// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  BlackboardEntrySchema,
  NewBlackboardEntrySchema,
  type Blackboard,
  type BlackboardEntry,
  type NewBlackboardEntry,
} from '../ports/blackboard.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { parseOrThrow } from './support.js';

export const BLACKBOARD_SPEC: TableSpec<BlackboardEntry> = {
  name: 'blackboard',
  schema: BlackboardEntrySchema,
  key: ['playId', 'key', 'version'],
  json: ['value'],
};

/** `Blackboard` over a {@link RecordTable}. */
export class TableBlackboard implements Blackboard {
  constructor(
    private readonly table: RecordTable<BlackboardEntry>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async put(input: NewBlackboardEntry): Promise<BlackboardEntry> {
    const given = parseOrThrow(NewBlackboardEntrySchema, input, 'blackboard entry');
    const [last] = await this.table.select({
      eq: { playId: given.playId, key: given.key },
      orderBy: [{ field: 'version', desc: true }],
      limit: 1,
    });
    const entry: BlackboardEntry = {
      playId: given.playId,
      key: given.key,
      version: (last?.version ?? 0) + 1,
      value: given.value,
      author: given.author ?? null,
      createdAt: this.clock.now(),
    };
    await this.table.insert(entry);
    return entry;
  }

  async get(playId: string, key: string, version?: number): Promise<BlackboardEntry | undefined> {
    if (version !== undefined) return this.table.get({ playId, key, version });
    const [last] = await this.table.select({
      eq: { playId, key },
      orderBy: [{ field: 'version', desc: true }],
      limit: 1,
    });
    return last;
  }

  history(playId: string, key: string): Promise<readonly BlackboardEntry[]> {
    return this.table.select({ eq: { playId, key }, orderBy: [{ field: 'version' }] });
  }

  async latest(playId: string): Promise<readonly BlackboardEntry[]> {
    // Newest version first within a key, so the first row seen for each key is its latest.
    const rows = await this.table.select({
      eq: { playId },
      orderBy: [{ field: 'key' }, { field: 'version', desc: true }],
    });
    const out: BlackboardEntry[] = [];
    for (const row of rows) {
      if (out[out.length - 1]?.key !== row.key) out.push(row);
    }
    return out;
  }
}
