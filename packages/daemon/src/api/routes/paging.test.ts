// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../handlers.js';
import { decodeCursor, encodeCursor, paginate } from './paging.js';

interface Row {
  readonly id: string;
  readonly at: number;
}

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r${String(index + 1)}`, at: 1000 + index }));

const keyOf = (row: Row): [number, string] => [row.at, row.id];

describe('paginate', () => {
  it('walks every item once, in key order, whatever the order of the source', () => {
    const source = rows(7).reverse();
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = paginate(source, keyOf, { after, limit: 3 });
      seen.push(...page.items.map((row) => row.id));
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    expect(seen).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('gives no cursor on the last page, nor when the list fits one page', () => {
    expect(paginate(rows(3), keyOf, { limit: 3 }).nextCursor).toBeNull();
    expect(paginate(rows(3), keyOf, { limit: 2 }).nextCursor).not.toBeNull();
    expect(paginate([], keyOf, { limit: 2 })).toEqual({ items: [], nextCursor: null });
  });

  it('breaks a tie of the first part of the key by the next part', () => {
    const tied = [
      { id: 'b', at: 5 },
      { id: 'a', at: 5 },
      { id: 'c', at: 5 },
    ];
    const first = paginate(tied, keyOf, { limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual(['a']);
    const second = paginate(tied, keyOf, { after: first.nextCursor ?? '', limit: 1 });
    expect(second.items.map((row) => row.id)).toEqual(['b']);
  });

  it('compares numbers as numbers, not as text', () => {
    const seqs = [{ seq: 9 }, { seq: 10 }, { seq: 2 }];
    const page = paginate(seqs, (row) => [row.seq], { limit: 3 });
    expect(page.items.map((row) => row.seq)).toEqual([2, 9, 10]);
  });

  it('loses nothing between pages when items are written in between', () => {
    const source = rows(6);
    const first = paginate(source, keyOf, { limit: 3 });
    // A write between the pages: newer items arrive, and an older one is not touched.
    source.push({ id: 'r7', at: 1006 }, { id: 'r8', at: 1007 });
    const second = paginate(source, keyOf, { after: first.nextCursor ?? '', limit: 3 });
    const third = paginate(source, keyOf, { after: second.nextCursor ?? '', limit: 3 });
    const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
    expect(ids).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    expect(third.nextCursor).toBeNull();
  });

  it('does not repeat an item when one before the cursor is removed in between', () => {
    const source = rows(6);
    const first = paginate(source, keyOf, { limit: 3 });
    const without = source.filter((row) => row.id !== 'r1');
    const second = paginate(without, keyOf, { after: first.nextCursor ?? '', limit: 3 });
    expect(second.items.map((row) => row.id)).toEqual(['r4', 'r5', 'r6']);
  });
});

describe('the cursor', () => {
  it('round-trips a key and is opaque base64url', () => {
    const cursor = encodeCursor([1763600000000, 'S1']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, [0, ''])).toEqual([1763600000000, 'S1']);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['json that is not an array', Buffer.from('{"a":1}').toString('base64url')],
    ['an array of another length', encodeCursor([1])],
    ['an array of other types', encodeCursor(['x', 1])],
    ['null', Buffer.from('null').toString('base64url')],
  ])('refuses %s with invalid_input on the field after', (_name, cursor) => {
    expect(() => paginate(rows(3), keyOf, { after: cursor, limit: 2 })).toThrow(ApiFailure);
    try {
      paginate(rows(3), keyOf, { after: cursor, limit: 2 });
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_input', details: { field: 'after' } });
    }
  });
});
