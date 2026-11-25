// SPDX-License-Identifier: MPL-2.0
import { isMap, isSeq, LineCounter, parseDocument, type Document, type Node } from 'yaml';
import {
  validateWorkflow,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationResult,
} from './validate.js';

/**
 * The YAML of a definition (docs/24, §4). The text is read with the core schema of YAML 1.2 (a
 * custom tag is refused), unique keys and a bound on aliases; the limits are options with a default, which
 * the daemon takes from its configuration. [proposta]
 */
export interface YamlLimits {
  /** Default 256 KiB. */
  readonly maxBytes: number;
  /** Default 50. */
  readonly maxAliases: number;
}
export const DEFAULT_YAML_LIMITS: YamlLimits = { maxBytes: 256 * 1024, maxAliases: 50 };

/** A place in the text, 1-based, for the editor (P11). */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

export interface YamlIssue {
  readonly message: string;
  readonly position?: TextPosition;
}

export type YamlParseResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly document: Document;
      readonly lines: LineCounter;
    }
  | { readonly ok: false; readonly errors: readonly YamlIssue[] };

export function parseWorkflowYaml(
  text: string,
  limits: YamlLimits = DEFAULT_YAML_LIMITS,
): YamlParseResult {
  const size = new TextEncoder().encode(text).length;
  if (size > limits.maxBytes) {
    return {
      ok: false,
      errors: [
        {
          message: `the definition has ${String(size)} bytes; the limit is ${String(limits.maxBytes)}`,
        },
      ],
    };
  }
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    uniqueKeys: true,
    schema: 'core',
    prettyErrors: false,
  });
  // A warning of the YAML (an unknown tag, for one) is an error here: a definition is plain data.
  const errors: YamlIssue[] = [...document.errors, ...document.warnings].map((error) => {
    const at = lines.linePos(error.pos[0]);
    return { message: error.message, position: { line: at.line, column: at.col } };
  });
  if (errors.length > 0) return { ok: false, errors };
  try {
    return {
      ok: true,
      value: document.toJS({ maxAliasCount: limits.maxAliases }),
      document,
      lines,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/** Where the node at `segments` starts in the text, or the nearest parent that exists. */
export function positionOf(
  document: Document,
  lines: LineCounter,
  segments: readonly (string | number)[],
): TextPosition | undefined {
  let current: unknown = document.contents;
  let best: Node | undefined = isMap(current) || isSeq(current) ? current : undefined;
  for (const segment of segments) {
    if (isMap(current)) {
      const pair = current.items.find((item) => {
        const key = item.key as { value?: unknown } | null;
        return key !== null && typeof key === 'object' && key.value === segment;
      });
      if (pair === undefined) break;
      current = pair.value;
      const keyNode = pair.key as Node | null;
      best = (pair.value as Node | null) ?? keyNode ?? best;
    } else if (isSeq(current) && typeof segment === 'number') {
      current = current.items[segment];
      if (current === undefined || current === null) break;
      best = current as Node;
    } else {
      break;
    }
  }
  const offset = best?.range?.[0];
  if (offset === undefined) return undefined;
  const pos = lines.linePos(offset);
  return { line: pos.line, column: pos.col };
}

export type YamlValidationResult =
  | { readonly stage: 'yaml'; readonly ok: false; readonly errors: readonly YamlIssue[] }
  | (ValidationResult & {
      readonly stage: 'definition';
      readonly positions: ReadonlyMap<ValidationIssue<string>, TextPosition>;
    });

/** Reads and validates a YAML definition; the errors of the validator carry their place in the text. */
export function validateWorkflowYaml(
  text: string,
  options: ValidateOptions & { readonly yaml?: YamlLimits } = {},
): YamlValidationResult {
  const parsed = parseWorkflowYaml(text, options.yaml);
  if (!parsed.ok) return { stage: 'yaml', ok: false, errors: parsed.errors };
  const result = validateWorkflow(parsed.value, options);
  const positions = new Map<ValidationIssue<string>, TextPosition>();
  for (const issue of [...result.errors, ...result.warnings]) {
    const position = positionOf(parsed.document, parsed.lines, issue.segments);
    if (position !== undefined) positions.set(issue, position);
  }
  return { ...result, stage: 'definition', positions };
}
