// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWorkflowDefinitionJsonSchema,
  renderWorkflowDefinitionJsonSchema,
  WORKFLOW_DEFINITION_SCHEMA_FILE,
} from './schema-file.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const file = path.join(root, WORKFLOW_DEFINITION_SCHEMA_FILE);

describe('the JSON Schema of a workflow definition', () => {
  it('is draft 2020-12, closed, inline, with the required fields', () => {
    const schema = buildWorkflowDefinitionJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.title).toBe('OTheater workflow definition');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(schema.required).toEqual(['id', 'version', 'engine', 'nodes', 'edges']);
    expect(JSON.stringify(schema)).not.toContain('$ref');
  });

  it('is the same on every run and ends with a newline', () => {
    expect(renderWorkflowDefinitionJsonSchema()).toBe(
      renderWorkflowDefinitionJsonSchema(buildWorkflowDefinitionJsonSchema()),
    );
    expect(renderWorkflowDefinitionJsonSchema().endsWith('}\n')).toBe(true);
  });

  // The file is versioned. If this test fails, the format changed: regenerate it with
  // `pnpm workflow:schema` (vitest `-u` on this file) and commit it.
  it('matches the versioned file', async () => {
    expect(
      existsSync(file),
      `${WORKFLOW_DEFINITION_SCHEMA_FILE} is missing: run pnpm workflow:schema`,
    ).toBe(true);
    await expect(renderWorkflowDefinitionJsonSchema()).toMatchFileSnapshot(file);
  });
});
