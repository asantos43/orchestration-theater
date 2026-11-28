// SPDX-License-Identifier: MPL-2.0
import type { JsonObject, JsonValue } from '@otheater/core';

/**
 * `ot flow diff` (Phase 11b, P10b; [proposta]): what changed between two versions of a definition,
 * part by part and not line by line, so a Producer reads "node `review` changed, edge `a -> b`
 * added" instead of a text diff of a YAML whose layout does not matter.
 *
 * The rule is generic, with no knowledge of the schema of the definition, so a new key of the
 * definition (a new field the engine grows) is compared with no change here:
 * - a key whose value is an object (`inputs`, `limits`, `nodes`, `requires`) is compared child by
 *   child: the `key` is the name of the child;
 * - a key whose value is a list (`edges`, `triggers`) is compared as a set of items by their
 *   canonical JSON: an item that is only in one side is `added` or `removed` (a changed item is
 *   one of each), and the `key` is the item as text (an edge written `a -> b` is its own text);
 * - any other key (`description`, `engine`, `start`) is compared as a whole, with the `key` of the
 *   key itself;
 * - `id` is never compared (the two sides are of one workflow) and `version` is the question, so
 *   both are left out.
 */

export type WorkflowChangeKind = 'added' | 'removed' | 'changed';

export interface WorkflowChange {
  /** The top-level key of the definition the change is in (`nodes`, `edges`, `inputs`...). */
  readonly area: string;
  /** The child of the area (a node id, an input name, an edge), or the area itself for a plain key. */
  readonly key: string;
  readonly change: WorkflowChangeKind;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
}

const SKIPPED = new Set(['id', 'version']);

/** Keys in a fixed order, so the same pair of documents always gives the same list. */
function sortedKeys(...objects: readonly JsonObject[]): string[] {
  return [...new Set(objects.flatMap((object) => Object.keys(object)))].sort();
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON of a value with the keys of every object sorted: equal documents give equal text. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function itemName(item: JsonValue): string {
  return typeof item === 'string' ? item : canonicalJson(item);
}

/** What changed from `before` to `after`; empty when the two documents are the same. */
export function diffWorkflows(before: JsonObject, after: JsonObject): readonly WorkflowChange[] {
  const changes: WorkflowChange[] = [];
  for (const area of sortedKeys(before, after)) {
    if (SKIPPED.has(area)) continue;
    const left = before[area];
    const right = after[area];
    if (left === undefined || right === undefined) {
      pushWhole(changes, area, left, right);
    } else if (isObject(left) && isObject(right)) {
      for (const key of sortedKeys(left, right)) {
        pushWhole(changes, area, left[key], right[key], key);
      }
    } else if (Array.isArray(left) && Array.isArray(right)) {
      const was = new Map(left.map((item) => [canonicalJson(item), item]));
      const now = new Map(right.map((item) => [canonicalJson(item), item]));
      for (const [text, item] of was) {
        if (!now.has(text)) {
          changes.push({ area, key: itemName(item), change: 'removed', before: item, after: null });
        }
      }
      for (const [text, item] of now) {
        if (!was.has(text)) {
          changes.push({ area, key: itemName(item), change: 'added', before: null, after: item });
        }
      }
    } else if (canonicalJson(left) !== canonicalJson(right)) {
      changes.push({ area, key: area, change: 'changed', before: left, after: right });
    }
  }
  return changes;
}

function pushWhole(
  changes: WorkflowChange[],
  area: string,
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  key: string = area,
): void {
  if (left === undefined && right === undefined) return;
  if (left === undefined) {
    changes.push({ area, key, change: 'added', before: null, after: right ?? null });
  } else if (right === undefined) {
    changes.push({ area, key, change: 'removed', before: left, after: null });
  } else if (canonicalJson(left) !== canonicalJson(right)) {
    changes.push({ area, key, change: 'changed', before: left, after: right });
  }
}
