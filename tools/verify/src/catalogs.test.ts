// SPDX-License-Identifier: MPL-2.0
import { afterAll, describe, expect, it } from 'vitest';
import { checkCatalogs, readCatalogs } from './catalogs.js';
import { loadPolicy } from './policy.js';
import { cleanupTemp, makeTemp, POLICY_FILE, REPOSITORY_ROOT, writeTree } from './test-helpers.js';

afterAll(cleanupTemp);

const catalogsPolicy = loadPolicy(POLICY_FILE).catalogs;

function check(files: Record<string, string>): string[] {
  const root = makeTemp();
  writeTree(root, Object.fromEntries(Object.entries(files).map(([p, c]) => [`locales/${p}`, c])));
  const result = checkCatalogs(readCatalogs(root, catalogsPolicy), catalogsPolicy);
  return result.findings.map((f) => `${f.subject} ${f.message}`);
}

const json = (value: unknown): string => JSON.stringify(value);

describe('catalogs', () => {
  it('the repository catalogs pass', () => {
    const result = checkCatalogs(readCatalogs(REPOSITORY_ROOT, catalogsPolicy), catalogsPolicy);
    expect(result.findings).toEqual([]);
    expect(result.summary[0]).toContain('en, pt-BR');
  });

  it('accepts matching catalogs with nested keys and the same variables', () => {
    const findings = check({
      'en/common.json': json({ a: { b: 'Hello {{name}}', c: 'x' } }),
      'pt-BR/common.json': json({ a: { b: 'Olá {{ name }}', c: 'y' } }),
    });
    expect(findings).toEqual([]);
  });

  it('reports a key present in one language and missing in the other, recursively', () => {
    const findings = check({
      'en/common.json': json({ a: { b: 'x', only: 'y' } }),
      'pt-BR/common.json': json({ a: { b: 'x' }, extra: 'z' }),
    });
    expect(findings).toHaveLength(2);
    expect(findings.join('\n')).toContain('pt-BR/common.json:a.only');
    expect(findings.join('\n')).toContain('en/common.json:extra');
  });

  it('reports a namespace present in one language only', () => {
    const findings = check({
      'en/common.json': json({ a: 'x' }),
      'en/errors.json': json({ e: 'x' }),
      'pt-BR/common.json': json({ a: 'x' }),
    });
    expect(findings.join('\n')).toContain('namespace "errors" is missing in "pt-BR"');
  });

  it('reports empty values and non-string leaves', () => {
    const findings = check({
      'en/common.json': json({ a: '', b: 3, c: ['x'], d: null, e: '  ' }),
      'pt-BR/common.json': json({ a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' }),
    });
    expect(findings.filter((f) => f.includes('empty value'))).toHaveLength(2);
    expect(findings.filter((f) => f.includes('must be a string'))).toHaveLength(3);
  });

  it('reports different interpolation variables', () => {
    const findings = check({
      'en/common.json': json({ a: 'Hi {{name}}, {{count}} items', b: 'plain' }),
      'pt-BR/common.json': json({ a: 'Oi {{name}}', b: 'simples {{extra}}' }),
    });
    expect(findings).toHaveLength(2);
    expect(findings.join('\n')).toContain('expected {count, name}, found {name}');
  });

  it('plural forms compare by base key (pt-BR has more plural categories than en)', () => {
    const findings = check({
      'en/common.json': json({ item_one: '{{count}} item', item_other: '{{count}} items' }),
      'pt-BR/common.json': json({
        item_one: '{{count}} item',
        item_many: '{{count}} de itens',
        item_other: '{{count}} itens',
      }),
    });
    expect(findings).toEqual([]);
  });

  it('reports a required language that is missing, and invalid JSON', () => {
    expect(check({ 'en/common.json': json({ a: 'x' }) }).join('\n')).toContain(
      'required language is missing',
    );
    expect(
      check({ 'en/common.json': '{', 'pt-BR/common.json': json({ a: 'x' }) }).join('\n'),
    ).toContain('invalid JSON');
  });

  it('reports a missing locales directory', () => {
    const root = makeTemp();
    expect(checkCatalogs(readCatalogs(root, catalogsPolicy), catalogsPolicy).findings).toHaveLength(
      1,
    );
  });
});
