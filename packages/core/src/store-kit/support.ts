// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { InvalidInput, NotFound } from '../errors.js';

/** Parses `input` with `schema`; a failure is an `InvalidInput` that names what was parsed. */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  label: string,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidInput(`Invalid ${label}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Throws `NotFound` for a missing record. */
export function mustExist<T>(found: T | undefined, what: string, id: string): T {
  if (found === undefined) throw new NotFound(`${what} ${id} does not exist`);
  return found;
}

/** The fields of `T`, all optional and allowed to be `undefined` (what a parsed patch looks like). */
export type FieldPatch<T> = { readonly [K in keyof T]?: T[K] | undefined };

/** `record` with the fields `patch` sets (a field left `undefined` in `patch` is kept). */
export function applyPatch<T extends object>(record: T, patch: FieldPatch<T>): T {
  const next = { ...record };
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[field] = value;
  }
  return next;
}

/** The set fields of `terms`, as the `eq` of a query (a field left `undefined` is dropped). */
export function eqTerms(
  terms: Readonly<Record<string, string | number | null | undefined>>,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [field, value] of Object.entries(terms)) {
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** The `in` of a query for an optional list of values (`undefined` adds no term). */
export function inTerm(
  field: string,
  values: readonly (string | number)[] | undefined,
): Record<string, readonly (string | number)[]> {
  return values === undefined ? {} : { [field]: values };
}
