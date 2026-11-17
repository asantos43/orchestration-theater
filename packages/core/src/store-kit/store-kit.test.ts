// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../testing/fake-clock.js';
import { InMemoryTables } from '../testing/in-memory-tables.js';
import {
  AGGREGATE_READ_METHODS,
  AGGREGATE_TABLE_NAMES,
  AGGREGATE_WRITE_METHODS,
  createStoreAggregates,
} from './index.js';

// The behaviour of the aggregates is exercised by the suites of @otheater/sdk, against every
// store. Here: the tables that tell reads from writes must cover every public method, or a new
// method would silently be missing from `store.*` (outside a transaction).
describe('store-kit method registries', () => {
  const aggregates = createStoreAggregates(new InMemoryTables().factory, new FakeClock());

  it.each(Object.keys(AGGREGATE_READ_METHODS))(
    '%s: every public method is listed once, as a read or as a write',
    (name) => {
      const key = name as keyof typeof aggregates;
      const prototype = Object.getPrototypeOf(aggregates[key]) as object;
      const methods = Object.getOwnPropertyNames(prototype)
        .filter((property) => property !== 'constructor')
        .sort();
      const listed = [...AGGREGATE_READ_METHODS[key], ...AGGREGATE_WRITE_METHODS[key]].sort();
      expect(listed).toEqual(methods);
      expect(new Set(listed).size).toBe(listed.length);
    },
  );

  it('lists the same aggregates for reads and writes', () => {
    expect(Object.keys(AGGREGATE_WRITE_METHODS).sort()).toEqual(
      Object.keys(AGGREGATE_READ_METHODS).sort(),
    );
  });

  it('has one table per migrated name, without repeats', () => {
    expect(new Set(AGGREGATE_TABLE_NAMES).size).toBe(AGGREGATE_TABLE_NAMES.length);
    expect(AGGREGATE_TABLE_NAMES).toHaveLength(Object.keys(AGGREGATE_READ_METHODS).length);
  });
});
