// SPDX-License-Identifier: MPL-2.0
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compareStrings, isRecord, type CheckResult, type Finding } from './common.js';
import type { CatalogsPolicy } from './policy.js';

/** language -> namespace -> parsed JSON (or the error found while reading it). */
export type CatalogSet = Map<string, Map<string, { value: unknown } | { error: string }>>;

export function readCatalogs(root: string, policy: CatalogsPolicy): CatalogSet {
  const base = path.join(root, policy.directory);
  const set: CatalogSet = new Map();
  if (!existsSync(base)) return set;
  for (const language of readdirSync(base).sort(compareStrings)) {
    const dir = path.join(base, language);
    if (!statSync(dir).isDirectory()) continue;
    const namespaces = new Map<string, { value: unknown } | { error: string }>();
    for (const file of readdirSync(dir).sort(compareStrings)) {
      if (!file.endsWith('.json')) continue;
      const namespace = file.slice(0, -'.json'.length);
      try {
        namespaces.set(namespace, {
          value: JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown,
        });
      } catch (error) {
        namespaces.set(namespace, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    set.set(language, namespaces);
  }
  return set;
}

interface Leaf {
  /** Key with the plural suffix removed, so `item_one` and `item_other` compare as `item`. */
  key: string;
  variables: Set<string>;
}

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;
const VARIABLE = /\{\{\s*([^,}\s]+)[^}]*\}\}/g;

function variablesOf(text: string): string[] {
  return [...text.matchAll(VARIABLE)].map((m) => m[1] ?? '');
}

/** Flattens a namespace into leaves keyed by dotted path; reports empty and non-string leaves. */
function flatten(
  value: unknown,
  prefix: string,
  where: string,
  leaves: Map<string, Leaf>,
  findings: Finding[],
): void {
  if (!isRecord(value)) {
    findings.push({
      severity: 'error',
      subject: where,
      message: 'the catalog root must be an object',
    });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;
    if (isRecord(child)) {
      flatten(child, dotted, where, leaves, findings);
    } else if (typeof child !== 'string') {
      findings.push({
        severity: 'error',
        subject: `${where}:${dotted}`,
        message: `value must be a string (found ${Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child})`,
      });
    } else if (child.trim() === '') {
      findings.push({ severity: 'error', subject: `${where}:${dotted}`, message: 'empty value' });
    } else {
      const normalized = dotted.replace(PLURAL_SUFFIX, '');
      const existing = leaves.get(normalized);
      const variables = variablesOf(child);
      if (existing === undefined)
        leaves.set(normalized, { key: normalized, variables: new Set(variables) });
      else for (const v of variables) existing.variables.add(v);
    }
  }
}

export function checkCatalogs(catalogs: CatalogSet, policy: CatalogsPolicy): CheckResult {
  const findings: Finding[] = [];
  const error = (subject: string, message: string): void => {
    findings.push({ severity: 'error', subject, message });
  };
  if (catalogs.size === 0) {
    error(policy.directory, 'no catalogs found (expected one directory per language)');
    return { summary: [], findings };
  }
  for (const language of policy.requiredLanguages) {
    if (!catalogs.has(language))
      error(`${policy.directory}/${language}`, 'required language is missing');
  }
  const languages = [...catalogs.keys()].sort(compareStrings);
  const reference = catalogs.has(policy.referenceLanguage)
    ? policy.referenceLanguage
    : languages[0];
  const allNamespaces = new Set<string>();
  for (const namespaces of catalogs.values())
    for (const ns of namespaces.keys()) allNamespaces.add(ns);

  let keyCount = 0;
  for (const namespace of [...allNamespaces].sort(compareStrings)) {
    const perLanguage = new Map<string, Map<string, Leaf>>();
    for (const language of languages) {
      const where = `${policy.directory}/${language}/${namespace}.json`;
      const entry = catalogs.get(language)?.get(namespace);
      if (entry === undefined) {
        error(where, `namespace "${namespace}" is missing in "${language}"`);
        continue;
      }
      if ('error' in entry) {
        error(where, `invalid JSON: ${entry.error}`);
        continue;
      }
      const leaves = new Map<string, Leaf>();
      flatten(entry.value, '', where, leaves, findings);
      perLanguage.set(language, leaves);
    }
    const allKeys = new Set<string>();
    for (const leaves of perLanguage.values()) for (const key of leaves.keys()) allKeys.add(key);
    keyCount += allKeys.size;
    for (const key of [...allKeys].sort(compareStrings)) {
      for (const [language, leaves] of perLanguage) {
        if (!leaves.has(key)) {
          error(
            `${policy.directory}/${language}/${namespace}.json:${key}`,
            `key present in another language but missing in "${language}"`,
          );
        }
      }
      const base = reference === undefined ? undefined : perLanguage.get(reference)?.get(key);
      if (reference === undefined || base === undefined) continue;
      for (const [language, leaves] of perLanguage) {
        const leaf = leaves.get(key);
        if (language === reference || leaf === undefined) continue;
        const expected = [...base.variables].sort(compareStrings).join(', ');
        const found = [...leaf.variables].sort(compareStrings).join(', ');
        if (expected !== found) {
          error(
            `${policy.directory}/${language}/${namespace}.json:${key}`,
            `interpolation variables differ from "${reference}": expected {${expected}}, found {${found}}`,
          );
        }
      }
    }
  }
  return {
    summary: [
      `languages: ${languages.join(', ')}; namespaces: ${String(allNamespaces.size)}; keys: ${String(keyCount)}`,
    ],
    findings,
  };
}
