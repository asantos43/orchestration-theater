// SPDX-License-Identifier: MPL-2.0
import { normalizeEdge, type WorkflowDefinition } from './definition.js';

/**
 * The stable hash of a definition (docs/24, §4): the sha256 of the canonical JSON. The canonical
 * form writes every edge as an object, trims the conditions and sorts the keys, so neither the
 * order of the keys nor the written form of an edge changes the hash. The order of `edges` does
 * change it: it is the order in which the edges are tried.
 */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

/** The canonical JSON of a definition that passed the schema. */
export function canonicalWorkflowJson(definition: WorkflowDefinition): string {
  const edges = definition.edges.map((raw) => {
    const normalized = normalizeEdge(raw);
    if (!normalized.ok) return raw;
    const { when, ...rest } = normalized.edge;
    return when === undefined ? rest : { ...rest, when: when.trim() };
  });
  return JSON.stringify(sortKeys({ ...definition, edges }));
}

/** `sha256:<hex>` of the canonical JSON, by Web Crypto (Node, browsers, the TUI). */
export async function workflowHash(definition: WorkflowDefinition): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWorkflowJson(definition));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
