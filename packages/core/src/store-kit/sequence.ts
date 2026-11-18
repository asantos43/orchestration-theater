// SPDX-License-Identifier: MPL-2.0
import type { RecordTable } from './record-table.js';

/** The next `seq` of a table whose records carry one: the last plus one, from 1. */
export async function nextSeq(table: RecordTable<{ seq: number }>): Promise<number> {
  const [last] = await table.select({ orderBy: [{ field: 'seq', desc: true }], limit: 1 });
  return (last?.seq ?? 0) + 1;
}
