// SPDX-License-Identifier: MPL-2.0
import { typeAtPath, type FieldType } from './field-types.js';

/**
 * The outputs of a node in the nodes that come after it (plan of Phase 11b, P10c). A string in the
 * `params` of a node may hold `${nodes.<node>.<field>}` (the output of an earlier node) or
 * `${inputs.<name>}` (an input of the run); the runtime puts the value in just before the step
 * runs. [proposta] The syntax, and `$${` as the way to write a literal `${`.
 *
 * - A string that is ONE reference gives the value as it is (a number stays a number); a string
 *   with text around the references gives text, and every reference in it must be a scalar.
 * - The validator checks, before a run: the syntax, that the node exists and can come before the
 *   one that reads it (it reaches it by the edges), that the field exists in the output type of
 *   its step, and that the input is declared.
 * - At run time a reference with no value (the node did not run yet in this run, or its output has
 *   no such field) is a failure of the step (`interpolation_unresolved`), never an empty string.
 */

/** One reference found in a text. */
export interface InterpolationRef {
  readonly root: 'nodes' | 'inputs';
  /** The node (when `root` is `nodes`) or the input (when `inputs`). */
  readonly name: string;
  /** The path below the node's output or the input; empty for an input. */
  readonly path: readonly string[];
  /** The text of the reference, `nodes.review.verdict`. */
  readonly text: string;
}

/** A piece of a string: literal text or a reference. */
export type InterpolationPart = string | InterpolationRef;

export type ParsedInterpolation =
  | { readonly ok: true; readonly parts: readonly InterpolationPart[] }
  | { readonly ok: false; readonly message: string };

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseReference(text: string): InterpolationRef | string {
  const segments = text.split('.');
  const [root, name, ...path] = segments;
  if (root !== 'nodes' && root !== 'inputs') {
    return `\${${text}} must start with nodes. or inputs.`;
  }
  if (name === undefined || !SEGMENT.test(name)) {
    return `\${${text}} has no valid name after ${root}.`;
  }
  if (root === 'nodes' && path.length === 0) {
    return `\${${text}} names a node but not a field of its output`;
  }
  if (root === 'inputs' && path.length > 0) {
    return `\${${text}}: an input is read whole`;
  }
  if (!path.every((segment) => SEGMENT.test(segment))) {
    return `\${${text}} has an invalid field name`;
  }
  return { root, name, path, text };
}

/** Splits a string into literal text and references. `$${` is a literal `${`. */
export function parseInterpolation(text: string): ParsedInterpolation {
  const parts: InterpolationPart[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$${', i)) {
      literal += '${';
      i += 3;
      continue;
    }
    if (text.startsWith('${', i)) {
      const close = text.indexOf('}', i + 2);
      if (close === -1) return { ok: false, message: 'a ${ is not closed' };
      const parsed = parseReference(text.slice(i + 2, close).trim());
      if (typeof parsed === 'string') return { ok: false, message: parsed };
      if (literal !== '') parts.push(literal);
      literal = '';
      parts.push(parsed);
      i = close + 1;
      continue;
    }
    literal += text.charAt(i);
    i += 1;
  }
  if (literal !== '') parts.push(literal);
  return { ok: true, parts };
}

/** Whether a string has anything the interpolation reads (`${` or `$${`). */
export function hasInterpolation(text: string): boolean {
  return text.includes('${');
}

/** A string of the params with what is in it. */
export interface FoundInterpolation {
  /** Where in the params: `['body']`, `['labels', 1]`. */
  readonly segments: readonly (string | number)[];
  readonly parsed: ParsedInterpolation;
}

/** Walks the params of a node and gives every string that has a `${`. */
export function findInterpolations(params: unknown): FoundInterpolation[] {
  const found: FoundInterpolation[] = [];
  const walk = (value: unknown, segments: readonly (string | number)[]): void => {
    if (typeof value === 'string') {
      if (hasInterpolation(value)) found.push({ segments, parsed: parseInterpolation(value) });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...segments, index]);
      });
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) walk(item, [...segments, key]);
    }
  };
  walk(params, []);
  return found;
}

/** What the validator knows to judge a reference: the type of the output of each node and of the inputs. */
export interface InterpolationTypes {
  readonly outputOf: (node: string) => FieldType | undefined;
  readonly inputs: Readonly<Record<string, FieldType>>;
  /** Whether `from` can run before `to` (an edge path from `from` to `to`). */
  readonly canPrecede: (from: string, to: string) => boolean;
}

/** The problems of a reference read by the node `reader`; the empty list when it is fine. */
export function checkInterpolationRef(
  ref: InterpolationRef,
  reader: string,
  types: InterpolationTypes,
): string[] {
  if (ref.root === 'inputs') {
    return Object.hasOwn(types.inputs, ref.name) ? [] : [`no input ${ref.name}`];
  }
  const output = types.outputOf(ref.name);
  if (output === undefined) return [`no node ${ref.name}`];
  if (!types.canPrecede(ref.name, reader)) {
    return [`${ref.name} never runs before ${reader}`];
  }
  const type = typeAtPath(output, ref.path);
  if (type === null) return [`${ref.name} has no output field ${ref.path.join('.')}`];
  return [];
}

/** The values a run has: the inputs and the last output of each node that ran. */
export interface InterpolationScope {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export type Resolved<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function valueOf(ref: InterpolationRef, scope: InterpolationScope): unknown {
  if (ref.root === 'inputs') {
    return Object.hasOwn(scope.inputs, ref.name) ? scope.inputs[ref.name] : undefined;
  }
  if (!Object.hasOwn(scope.outputs, ref.name)) return undefined;
  let current: unknown = scope.outputs[ref.name];
  for (const segment of ref.path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveString(text: string, scope: InterpolationScope): Resolved<unknown> {
  const parsed = parseInterpolation(text);
  if (!parsed.ok) return { ok: false, detail: parsed.message };
  const only = parsed.parts.length === 1 ? parsed.parts[0] : undefined;
  if (only !== undefined && typeof only !== 'string') {
    const value = valueOf(only, scope);
    return value === undefined
      ? { ok: false, detail: `${only.text} has no value` }
      : { ok: true, value };
  }
  let out = '';
  for (const part of parsed.parts) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    const value = valueOf(part, scope);
    if (value === undefined || value === null) {
      return { ok: false, detail: `${part.text} has no value` };
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false, detail: `${part.text} is not a text, a number or a boolean` };
    }
    out += String(value);
  }
  return { ok: true, value: out };
}

/**
 * The params of a node with every `${...}` replaced by its value (and `$${` by `${`). The input
 * is not changed. Gives the first problem when a reference has no value.
 */
export function resolveInterpolations<T>(params: T, scope: InterpolationScope): Resolved<T> {
  let problem: string | undefined;
  const walk = (value: unknown): unknown => {
    if (problem !== undefined) return value;
    if (typeof value === 'string') {
      if (!hasInterpolation(value)) return value;
      const resolved = resolveString(value, scope);
      if (resolved.ok) return resolved.value;
      problem = resolved.detail;
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  const value = walk(params) as T;
  return problem === undefined ? { ok: true, value } : { ok: false, detail: problem };
}

/** The nodes whose output the params read, for the runtime to keep (`nodes.<node>`). */
export function referencedNodes(params: unknown): string[] {
  const names = new Set<string>();
  for (const { parsed } of findInterpolations(params)) {
    if (!parsed.ok) continue;
    for (const part of parsed.parts) {
      if (typeof part !== 'string' && part.root === 'nodes') names.add(part.name);
    }
  }
  return [...names].sort();
}
