// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { FlowConfigSchema } from './config.js';

/** Where the generated JSON Schema of a flow lives, relative to the root of the repository. */
export const FLOW_CONFIG_SCHEMA_FILE = 'docs/reference/flow-config.schema.json';

/**
 * The JSON Schema of one `flows.<id>` (draft 2020-12), generated like the one of the plugin
 * manifest: the fields as the author writes them. It carries the structure only; the rules that
 * look across fields (a mandatory step stays on, the role is the step's own, a limit belongs to an
 * enabled step) are the ones of `parseFlowConfig`. [proposta]
 */
export function buildFlowConfigJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(FlowConfigSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    reused: 'inline',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = json;
  return { $schema, title: 'OTheater flow (flows.<id>)', ...rest };
}

/** The text of the versioned file: stable JSON, two spaces, a final newline. */
export function renderFlowConfigJsonSchema(
  schema: Record<string, unknown> = buildFlowConfigJsonSchema(),
): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
