// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { WorkflowDefinitionSchema } from './definition.js';

/** Where the generated JSON Schema of a definition lives, relative to the root of the repository. */
export const WORKFLOW_DEFINITION_SCHEMA_FILE = 'docs/reference/workflow-definition.schema.json';

/**
 * The JSON Schema of a workflow definition (draft 2020-12), for editors and for the YAML language
 * server. It carries the structure only; the rules that look across fields (the step types, the
 * conditions, reachability, cycles, approval) are the ones of `validateWorkflow`. [proposta]
 */
export function buildWorkflowDefinitionJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(WorkflowDefinitionSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    reused: 'inline',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = json;
  return { $schema, title: 'OTheater workflow definition', ...rest };
}

/** The text of the versioned file: stable JSON, two spaces, a final newline. */
export function renderWorkflowDefinitionJsonSchema(
  schema: Record<string, unknown> = buildWorkflowDefinitionJsonSchema(),
): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
