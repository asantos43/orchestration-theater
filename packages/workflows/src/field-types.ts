// SPDX-License-Identifier: MPL-2.0

/**
 * The types the condition language can read (docs/24, §4 and §5; plan of Phase 11b, P1). They
 * describe the typed output of a step and the inputs of a definition, so the validator can tell,
 * before anything runs, that `output.verdict == "ok"` reads a field that exists and compares it with
 * a value it can take. [proposta]
 *
 * - `string`, `number`, `boolean`: a scalar;
 * - `{ enum: [...] }`: a string with a closed set of values;
 * - `{ list: T }`: a list of `T` (only `in` reads it);
 * - `{ object: { ... } }`: named fields (only a path reads it);
 * - `unknown`: a value the validator cannot check; a condition may only test it for `null`.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'unknown'
  | { readonly enum: readonly string[] }
  | { readonly list: FieldType }
  | { readonly object: Readonly<Record<string, FieldType>> };

/** The empty output: a step that returns nothing a condition can read. */
export const NO_OUTPUT: FieldType = { object: {} };

export function isEnumType(type: FieldType): type is { readonly enum: readonly string[] } {
  return typeof type === 'object' && 'enum' in type;
}

export function isListType(type: FieldType): type is { readonly list: FieldType } {
  return typeof type === 'object' && 'list' in type;
}

export function isObjectType(
  type: FieldType,
): type is { readonly object: Readonly<Record<string, FieldType>> } {
  return typeof type === 'object' && 'object' in type;
}

/** A short text for an error message: `string`, `enum(ok|redo)`, `list(string)`, `object`. */
export function describeType(type: FieldType): string {
  if (typeof type === 'string') return type;
  if (isEnumType(type)) return `enum(${type.enum.join('|')})`;
  if (isListType(type)) return `list(${describeType(type.list)})`;
  return 'object';
}

/** The scalar kind of a type, for the comparisons: an enum compares as a string. */
export function scalarKind(type: FieldType): 'string' | 'number' | 'boolean' | 'unknown' | null {
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'unknown') {
    return type;
  }
  if (isEnumType(type)) return 'string';
  return null;
}

/**
 * The type of the value at `path` inside `root`, or `null` when a segment does not exist. A path
 * through `unknown` stays `unknown`: the validator cannot say more.
 */
export function typeAtPath(root: FieldType, path: readonly string[]): FieldType | null {
  let current: FieldType = root;
  for (const segment of path) {
    if (current === 'unknown') return 'unknown';
    if (!isObjectType(current)) return null;
    const next: FieldType | undefined = Object.hasOwn(current.object, segment)
      ? current.object[segment]
      : undefined;
    if (next === undefined) return null;
    current = next;
  }
  return current;
}
