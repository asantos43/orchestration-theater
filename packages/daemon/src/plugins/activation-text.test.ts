// SPDX-License-Identifier: MPL-2.0
import { parsePluginManifestText } from '@otheater/core';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n.js';
import { formatActivation, summarizeActivation } from './activation-text.js';
import { manifestText } from './plugin-fixture.js';

function manifest(variant: 'base' | 'changed') {
  const parsed = parsePluginManifestText(manifestText({ variant }), parseYaml);
  if (!parsed.ok) throw new Error('fixture manifest is invalid');
  return parsed.manifest;
}

describe('the activation summary (N236)', () => {
  it('lists the server, the tools with roles and effects, the secrets and the full event types', () => {
    const summary = summarizeActivation(manifest('changed'));
    expect(summary.id).toBe('demo-db');
    expect(summary.server.type).toBe('stdio');
    expect(summary.tools.map((tool) => tool.name)).toEqual(['query_sql', 'drop_table']);
    expect(summary.secrets).toEqual(['PG_URL']);
    for (const event of summary.events) expect(event.startsWith('plugin.demo-db.')).toBe(true);
  });

  it('is plain data: it holds names of secrets and no value', () => {
    expect(JSON.stringify(summarizeActivation(manifest('changed')))).not.toMatch(/postgres:\/\//);
  });

  it.each([
    ['en', /asks for/, /Tools: 2/],
    ['pt-BR', /pede/, /Ferramentas: 2/],
  ] as const)('is printed in %s from the catalog', async (locale, title, tools) => {
    const t = await createTranslator(locale);
    const text = formatActivation(summarizeActivation(manifest('changed')), t).join('\n');
    expect(text).toMatch(title);
    expect(text).toMatch(tools);
    expect(text).toContain('PG_URL');
    expect(text).toContain('drop_table');
    // No key was left untranslated.
    expect(text).not.toMatch(/plugin\.activation\./);
  });
});
