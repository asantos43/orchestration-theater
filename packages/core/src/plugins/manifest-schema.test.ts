// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPluginManifestJsonSchema,
  PLUGIN_MANIFEST_SCHEMA_FILE,
  renderPluginManifestJsonSchema,
} from './manifest-schema.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const file = path.join(root, PLUGIN_MANIFEST_SCHEMA_FILE);

describe('the JSON Schema of the plugin manifest', () => {
  it('is draft 2020-12, with the fields the author writes and the ones that are required', () => {
    const schema = buildPluginManifestJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'manifest_version',
        'id',
        'version',
        'server',
        'tools',
      ]) as unknown,
    });
    const required = schema.required as string[];
    // Defaults make a field optional for the author.
    for (const name of ['secrets', 'events', 'triggers', 'panel', 'i18n'])
      expect(required).not.toContain(name);
    const properties = schema.properties as Record<string, unknown>;
    const toolProperties = (
      properties.tools as {
        items: { properties: Record<string, { enum?: string[]; items?: { enum: string[] } }> };
      }
    ).items.properties;
    expect(properties.manifest_version).toMatchObject({ const: 1 });
    expect(JSON.stringify(schema)).not.toContain('$ref');
    expect(toolProperties.effects?.enum).toEqual([
      'read',
      'local_write',
      'network',
      'external_write',
    ]);
    expect(toolProperties.roles?.items?.enum).toContain('actor');
    expect(toolProperties.roles?.items?.enum).not.toContain('director');
  });

  it('is the same on every run and ends with a newline', () => {
    expect(renderPluginManifestJsonSchema()).toBe(
      renderPluginManifestJsonSchema(buildPluginManifestJsonSchema()),
    );
    expect(renderPluginManifestJsonSchema().endsWith('}\n')).toBe(true);
  });

  // The file is versioned. If this test fails, the manifest changed: regenerate it with
  // `pnpm plugin:schema` (vitest `-u` on this file) and commit it.
  it('matches the versioned file', async () => {
    // Outside the CI a missing file would be written as a new snapshot: fail first.
    expect(
      existsSync(file),
      `${PLUGIN_MANIFEST_SCHEMA_FILE} is missing: run pnpm plugin:schema`,
    ).toBe(true);
    await expect(renderPluginManifestJsonSchema()).toMatchFileSnapshot(file);
  });
});
