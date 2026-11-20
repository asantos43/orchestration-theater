// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Cursor pagination and idempotent commands, shared by the REST routes (P5 and P6 of the plan
 * docs/17). [proposta] The whole page contract is a proposal of the plan.
 */

/** Items per page when the client does not say. */
export const API_PAGE_DEFAULT_LIMIT = 50;
/** The most items a page may carry: a larger `limit` is `invalid_input`, not clamped. */
export const API_PAGE_MAX_LIMIT = 200;

/**
 * Query of a list that grows. `after` is the `nextCursor` of the previous page: opaque, the client
 * never builds one. Routes extend this schema with their own filters.
 */
export const PageQuerySchema = z.strictObject({
  after: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(API_PAGE_MAX_LIMIT).default(API_PAGE_DEFAULT_LIMIT),
});
export type PageQuery = z.input<typeof PageQuerySchema>;

/**
 * The answer of a paginated list. `nextCursor` is `null` on the last page. A page is a window
 * over the order the route documents, taken after the cursor: a write between two pages never
 * makes an item vanish.
 */
export function pageOf<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().min(1).max(512).nullable(),
  });
}
export interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}

/** Header of a command that may be repeated: same key, same effect, same answer (P6). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** [proposta] 1 to 255 printable ASCII characters without spaces. */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/);

/** The request headers of a command, keyed by the lower-case name. */
export const IdempotencyHeadersSchema = z.looseObject({
  'idempotency-key': IdempotencyKeySchema.optional(),
});
