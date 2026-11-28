// SPDX-License-Identifier: MPL-2.0
import type { JsonObject, JsonValue } from '@otheater/core';
import {
  BUILTIN_STEP_TYPES,
  chooseEdge,
  isEnumType,
  isListType,
  isObjectType,
  stepTypeRegistry,
  validateWorkflow,
  type FieldType,
  type StepEffect,
  type ValidateOptions,
  type ValidationIssue,
  type ValidWorkflow,
} from '@otheater/workflows';
import type { WorkflowSimulateOnLimit } from './config.js';
import { resolveRunInputs } from './runtime.js';

/**
 * `ot flow simulate` (Phase 11b, P10b; [proposta], see the plan): a dry walk over a definition. It
 * runs no step: it validates the definition, gives the inputs, and from the start node it takes the
 * edge the engine would take (`chooseEdge`, the same function the machine of the runtime uses),
 * node by node, until a terminal state or `maxSteps` nodes. The output of every node is made up
 * from the typed output of its step type (the first value of an enum, `''`, `0`, `false`, `[]`),
 * and the caller can set it by node to follow another path, so `output.verdict == "redo"` is
 * reached by asking for it. Nothing here opens a session, spends quota or touches the code host:
 * it is the map of the paths, not a run. What each node would cause is listed from its step type
 * (`effects`), so a Producer sees what a real run could do.
 */

/** What the caller sets for a node: one output, or the outputs of its visits in order (the last one repeats). */
export type SimulatedOutputs = Readonly<Record<string, JsonObject | readonly JsonObject[]>>;

export interface SimulateOptions {
  /** `workflows.simulate.max_steps`. */
  readonly maxSteps: number;
  /** `workflows.simulate.on_limit`. */
  readonly onLimit: WorkflowSimulateOnLimit;
  readonly inputs?: Readonly<Record<string, unknown>> | undefined;
  readonly outputs?: SimulatedOutputs | undefined;
  /** Nodes whose step fails when the walk gets there (the run ends `failed`). */
  readonly fail?: readonly string[] | undefined;
  readonly validate?: ValidateOptions | undefined;
}

/** How the walk left a node. */
export type SimulatedVia = 'edge' | 'limit' | 'no_edge' | 'step_failed';

export interface SimulatedStep {
  readonly node: string;
  readonly step: string;
  readonly role: string | null;
  /** The output the edges read (made up, or the one the caller gave). */
  readonly output: JsonObject;
  /** What a real run of this node could cause (from its step type). */
  readonly effects: readonly StepEffect[];
  readonly via: SimulatedVia;
  /** The index in `edges` of the edge taken; absent when none was. */
  readonly edge?: number;
  readonly to: string;
}

export type SimulateStatus = 'done' | 'cancelled' | 'failed' | 'truncated';

export type SimulateResult =
  | {
      readonly ok: true;
      readonly workflow: { readonly id: string; readonly version: string };
      readonly status: SimulateStatus;
      /** The node the walk ended in (a terminal state, or the one it stopped at). */
      readonly ended: string;
      readonly inputs: JsonObject;
      readonly path: readonly SimulatedStep[];
      readonly counts: Readonly<Record<string, number>>;
      readonly warnings: readonly ValidationIssue<string>[];
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_definition' | 'invalid_inputs' | 'invalid_outputs' | 'step_limit';
      readonly detail: string;
      readonly errors: readonly ValidationIssue<string>[];
    };

const TERMINALS: ReadonlySet<string> = new Set(['done', 'cancelled', 'failed']);

/** A value of the type, the same every time: the first of an enum, empty or zero otherwise. */
export function sampleOf(type: FieldType): JsonValue {
  if (type === 'string') return '';
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'unknown') return null;
  if (isEnumType(type)) return type.enum[0] ?? '';
  if (isListType(type)) return [];
  if (isObjectType(type)) {
    const out: Record<string, JsonValue> = {};
    for (const [name, field] of Object.entries(type.object)) out[name] = sampleOf(field);
    return out;
  }
  return null;
}

/** Walks a definition (see the header). A definition that does not validate gives `invalid_definition`. */
export function simulateWorkflow(definition: unknown, options: SimulateOptions): SimulateResult {
  const validated = validateWorkflow(definition, options.validate ?? {});
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'invalid_definition',
      detail: 'the definition is not valid',
      errors: validated.errors,
    };
  }
  const workflow = validated.workflow;
  const unknownNodes = [...Object.keys(options.outputs ?? {}), ...(options.fail ?? [])].filter(
    (id) => !Object.hasOwn(workflow.nodes, id),
  );
  if (unknownNodes.length > 0) {
    return {
      ok: false,
      reason: 'invalid_outputs',
      detail: `the definition has no node ${[...new Set(unknownNodes)].join(', ')}`,
      errors: [],
    };
  }
  const given = resolveRunInputs(workflow, options.inputs ?? {});
  if (!given.ok) {
    return { ok: false, reason: 'invalid_inputs', detail: given.detail, errors: [] };
  }
  const registry = stepTypeRegistry(BUILTIN_STEP_TYPES);
  return walk(workflow, given.inputs, options, registry);
}

function walk(
  workflow: ValidWorkflow,
  inputs: JsonObject,
  options: SimulateOptions,
  registry: ReturnType<typeof stepTypeRegistry>,
): SimulateResult {
  const path: SimulatedStep[] = [];
  const visits = new Map<string, number>();
  const counts: Record<string, number> = {};
  const fails = new Set(options.fail ?? []);
  const base = {
    ok: true as const,
    workflow: { id: workflow.id, version: workflow.version },
    inputs,
    warnings: [] as readonly ValidationIssue<string>[],
  };
  let at = workflow.start;
  while (!TERMINALS.has(at)) {
    if (path.length >= options.maxSteps) {
      if (options.onLimit === 'fail') {
        return {
          ok: false,
          reason: 'step_limit',
          detail: `the walk passed ${String(options.maxSteps)} steps (workflows.simulate.max_steps)`,
          errors: [],
        };
      }
      return { ...base, status: 'truncated', ended: at, path, counts };
    }
    const node = workflow.nodes[at];
    if (node === undefined) return { ...base, status: 'failed', ended: at, path, counts };
    const spec = registry.get(node.step);
    const visit = visits.get(at) ?? 0;
    visits.set(at, visit + 1);
    const output = outputOf(at, visit, spec?.output, options.outputs);
    const common = {
      node: node.id,
      step: node.step,
      role: node.role,
      output,
      effects: spec?.effects ?? [],
    };
    if (fails.has(at)) {
      path.push({ ...common, via: 'step_failed', to: 'failed' });
      at = 'failed';
      break;
    }
    const choice = chooseEdge(workflow, at, { output, inputs, counts });
    if (choice.kind === 'none') {
      path.push({ ...common, via: 'no_edge', to: choice.target });
    } else {
      if (choice.kind === 'edge' && choice.edge.limit !== undefined) {
        counts[choice.edge.limit] = (counts[choice.edge.limit] ?? 0) + 1;
      }
      path.push({
        ...common,
        via: choice.kind === 'edge' ? 'edge' : 'limit',
        edge: choice.edge.index,
        to: choice.target,
      });
    }
    at = choice.target;
  }
  const status: SimulateStatus =
    at === 'done' ? 'done' : at === 'cancelled' ? 'cancelled' : 'failed';
  return { ...base, status, ended: at, path, counts };
}

function outputOf(
  node: string,
  visit: number,
  type: FieldType | undefined,
  given: SimulatedOutputs | undefined,
): JsonObject {
  const sample = type === undefined ? {} : (sampleOf(type) as JsonObject);
  const set = given?.[node];
  if (set === undefined) return sample;
  const chosen: JsonObject | undefined = Array.isArray(set)
    ? (set[Math.min(visit, set.length - 1)] as JsonObject | undefined)
    : (set as JsonObject);
  if (chosen === undefined || typeof sample !== 'object') return sample;
  return { ...sample, ...chosen };
}
