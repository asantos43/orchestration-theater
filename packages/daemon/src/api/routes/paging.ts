// SPDX-License-Identifier: MPL-2.0
import type { Page } from '@otheater/protocol';
import { ApiFailure } from '../handlers.js';

/**
 * Cursor pagination of the read routes (P5 of docs/17). [proposta] A cursor is a keyset: the key
 * of the last item of the page, as base64url JSON, opaque to the client. The next page is every
 * item whose key is greater, in the one order the route documents. A key never changes once an
 * item exists (`seq`, or `createdAt` and `id`), so a write between two pages can add an item but
 * never make one vanish or repeat. An offset would do both.
 */

/** One part of a key: a number (`seq`, `createdAt`, `version`) or a string (`id`, `key`). */
export type KeyPart = string | number;
export type Key = readonly KeyPart[];

/** What a list route takes of its query. */
export interface PageRequest {
  readonly after?: string | undefined;
  readonly limit: number;
}

function compareKeys(a: Key, b: Key): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function encodeCursor(key: Key): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** The key a cursor holds, with the shape `like` has; `invalid_input` when it is anything else. */
export function decodeCursor(cursor: string, like: Key): Key {
  const bad = (): ApiFailure =>
    new ApiFailure('invalid_input', 'The cursor is not one this route gave', {
      details: { field: 'after' },
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== like.length) throw bad();
  parsed.forEach((part: unknown, index) => {
    if (typeof part !== typeof like[index]) throw bad();
  });
  return parsed as Key;
}

/**
 * The page after `request.after` of `items`, in the ascending order of `keyOf`. The items need not
 * come sorted: the order is the key's, never the source's.
 */
export function paginate<Item>(
  items: readonly Item[],
  keyOf: (item: Item) => Key,
  request: PageRequest,
): Page<Item> {
  const keyed = items.map((item) => ({ item, key: keyOf(item) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  let rest = keyed;
  if (request.after !== undefined) {
    const first = keyed[0];
    // With no item there is no shape to check the cursor against: the page is empty either way.
    if (first !== undefined) {
      const after = decodeCursor(request.after, first.key);
      rest = keyed.filter((entry) => compareKeys(entry.key, after) > 0);
    }
  }
  const page = rest.slice(0, request.limit);
  const last = page[page.length - 1];
  const more = rest.length > page.length;
  return {
    items: page.map((entry) => entry.item),
    nextCursor: more && last !== undefined ? encodeCursor(last.key) : null,
  };
}
