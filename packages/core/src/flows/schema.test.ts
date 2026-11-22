// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFlowConfigJsonSchema,
  FLOW_CONFIG_SCHEMA_FILE,
  renderFlowConfigJsonSchema,
} from './schema.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const file = path.join(root, FLOW_CONFIG_SCHEMA_FILE);

describe('the JSON Schema of a flow', () => {
  it('is draft 2020-12, closed, with the nine steps and no permission field', () => {
    const schema = buildFlowConfigJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(schema.required).toEqual(['version']);
    const properties = schema.properties as Record<string, { properties?: object }>;
    expect(Object.keys(properties.steps?.properties ?? {})).toEqual([
      'planning',
      'clarifying',
      'plan_review',
      'scripting',
      'script_review',
      'execution',
      'integration',
      'critique',
      'delivery',
    ]);
    expect(JSON.stringify(schema)).not.toContain('$ref');
    expect(JSON.stringify(schema)).not.toContain('permission');
  });

  it('is the same on every run and ends with a newline', () => {
    expect(renderFlowConfigJsonSchema()).toBe(
      renderFlowConfigJsonSchema(buildFlowConfigJsonSchema()),
    );
    expect(renderFlowConfigJsonSchema().endsWith('}\n')).toBe(true);
  });

  // The file is versioned. If this test fails, the format changed: regenerate it with
  // `pnpm flow:schema` (vitest `-u` on this file) and commit it.
  it('matches the versioned file', async () => {
    expect(existsSync(file), `${FLOW_CONFIG_SCHEMA_FILE} is missing: run pnpm flow:schema`).toBe(
      true,
    );
    await expect(renderFlowConfigJsonSchema()).toMatchFileSnapshot(file);
  });
});
