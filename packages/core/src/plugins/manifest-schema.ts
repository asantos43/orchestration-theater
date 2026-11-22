// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { PluginManifestSchema } from './manifest.js';

/** Where the generated JSON Schema of the manifest lives, relative to the root of the repository. */
export const PLUGIN_MANIFEST_SCHEMA_FILE = 'docs/reference/plugin-manifest.schema.json';

/**
 * The JSON Schema of `plugin.yaml` (draft 2020-12), generated from {@link PluginManifestSchema}
 * with the fields as the author writes them (`io: 'input'`: a field with a default is optional).
 * It carries the structure only; the rules across fields (a `source` with `effects: read`, the
 * screen texts as catalog keys, no framework tool name) are checked by the validator. [proposta]
 */
export function buildPluginManifestJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(PluginManifestSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    reused: 'inline',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = json;
  return {
    $schema,
    title: 'OTheater plugin manifest (plugin.yaml)',
    ...rest,
  };
}

/** The text of the versioned file: stable JSON, two spaces, a final newline. */
export function renderPluginManifestJsonSchema(
  schema: Record<string, unknown> = buildPluginManifestJsonSchema(),
): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
