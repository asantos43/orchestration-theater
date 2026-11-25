// SPDX-License-Identifier: MPL-2.0
import { evaluateCondition } from './condition.js';
import { TERMINALS } from './definition.js';
import type { ValidWorkflow, WorkflowEdge } from './validate.js';

/**
 * The compiler (docs/24, §5): a valid workflow becomes the config of an XState machine. It is pure
 * data, with no import of xstate and no `createActor`: the runtime of the daemon (P2) gives the
 * guards and the actions by their names and runs it.
 *
 * - each node is a state, with `meta` (step, role, params, safe point);
 * - the runtime sends `workflow.step.done` with the typed `output` when the step ends, and
 *   `workflow.step.failed` when it fails;
 * - the transitions of `workflow.step.done` follow the edges of the node, in order. A limited edge
 *   comes first as "limit reached" (to `on_limit`, default `failed`), then as the edge itself,
 *   which counts;
 * - with no edge that matches, the run fails (`workflow.noEdge`);
 * - `done`, `cancelled` and `failed` are final; `workflow.cancel` goes to `cancelled` from any state.
 */

export const WORKFLOW_EVENTS = {
  stepDone: 'workflow.step.done',
  stepFailed: 'workflow.step.failed',
  cancel: 'workflow.cancel',
} as const;

export const WORKFLOW_GUARDS = {
  /** `params.edge`: the edge matches and its limit, if any, is not reached. */
  edge: 'workflow.edge',
  /** `params.edge`, `params.limit`: the edge matches, but its limit is reached. */
  limitReached: 'workflow.limitReached',
} as const;

export const WORKFLOW_ACTIONS = {
  /** `params.limit`: one more use of the counter. */
  count: 'workflow.count',
  /** `params.edge`, `params.limit`: the run hit the limit. */
  limitHit: 'workflow.limitHit',
  /** `params.node`: no edge matched the output. */
  noEdge: 'workflow.noEdge',
  /** `params.node`: the step failed. */
  stepFailed: 'workflow.stepFailed',
} as const;

export interface GuardRef {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface TransitionConfig {
  readonly target: string;
  readonly guard?: GuardRef;
  readonly actions?: readonly GuardRef[];
}

export interface StateConfig {
  readonly type?: 'final';
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly on?: Readonly<Record<string, readonly TransitionConfig[]>>;
}

export interface MachineConfig {
  readonly id: string;
  readonly initial: string;
  readonly on: Readonly<Record<string, readonly TransitionConfig[]>>;
  readonly states: Readonly<Record<string, StateConfig>>;
}

function transitions(node: string, edges: readonly WorkflowEdge[]): TransitionConfig[] {
  const out: TransitionConfig[] = [];
  for (const edge of edges) {
    if (edge.limit !== undefined) {
      out.push({
        target: edge.onLimit ?? 'failed',
        guard: {
          type: WORKFLOW_GUARDS.limitReached,
          params: { edge: edge.index, limit: edge.limit },
        },
        actions: [
          { type: WORKFLOW_ACTIONS.limitHit, params: { edge: edge.index, limit: edge.limit } },
        ],
      });
    }
    out.push({
      target: edge.to,
      guard: { type: WORKFLOW_GUARDS.edge, params: { edge: edge.index } },
      ...(edge.limit === undefined
        ? {}
        : { actions: [{ type: WORKFLOW_ACTIONS.count, params: { limit: edge.limit } }] }),
    });
  }
  out.push({ target: 'failed', actions: [{ type: WORKFLOW_ACTIONS.noEdge, params: { node } }] });
  return out;
}

/** The machine config of a valid workflow. The same workflow gives the same config. */
export function compileWorkflow(workflow: ValidWorkflow): MachineConfig {
  const states: Record<string, StateConfig> = {};
  for (const node of Object.values(workflow.nodes)) {
    states[node.id] = {
      meta: { step: node.step, role: node.role, params: node.params, safePoint: node.safePoint },
      on: {
        [WORKFLOW_EVENTS.stepDone]: transitions(node.id, node.edges),
        [WORKFLOW_EVENTS.stepFailed]: [
          {
            target: 'failed',
            actions: [{ type: WORKFLOW_ACTIONS.stepFailed, params: { node: node.id } }],
          },
        ],
      },
    };
  }
  for (const terminal of TERMINALS) states[terminal] = { type: 'final' };
  return {
    id: `${workflow.id}@${workflow.version}`,
    initial: workflow.start,
    on: { [WORKFLOW_EVENTS.cancel]: [{ target: '.cancelled' }] },
    states,
  };
}

/** What the runtime reads: the output of the step, the inputs of the run, the counters so far. */
export interface EdgeScope {
  readonly output: unknown;
  readonly inputs: unknown;
  /** Uses so far, by limit key. */
  readonly counts: Readonly<Record<string, number>>;
}

export type EdgeChoice =
  | { readonly kind: 'edge'; readonly edge: WorkflowEdge; readonly target: string }
  | { readonly kind: 'limit'; readonly edge: WorkflowEdge; readonly target: string }
  | { readonly kind: 'none'; readonly target: 'failed' };

/** Whether an edge matches the output (no condition: always). */
export function edgeMatches(edge: WorkflowEdge, scope: EdgeScope): boolean {
  return (
    edge.condition === undefined ||
    evaluateCondition(edge.condition, { output: scope.output, inputs: scope.inputs })
  );
}

/**
 * The edge the machine takes from `node`, by the same rule as the compiled config: the first edge
 * that matches; a limited one whose counter is used up goes to its `on_limit`. The guards of the
 * runtime are this function, edge by edge.
 */
export function chooseEdge(workflow: ValidWorkflow, node: string, scope: EdgeScope): EdgeChoice {
  for (const edge of workflow.nodes[node]?.edges ?? []) {
    if (!edgeMatches(edge, scope)) continue;
    if (edge.limit !== undefined) {
      const max = workflow.counters[edge.limit] ?? 0;
      if ((scope.counts[edge.limit] ?? 0) >= max) {
        return { kind: 'limit', edge, target: edge.onLimit ?? 'failed' };
      }
    }
    return { kind: 'edge', edge, target: edge.to };
  }
  return { kind: 'none', target: 'failed' };
}

/** The guard of {@link WORKFLOW_GUARDS.edge} or {@link WORKFLOW_GUARDS.limitReached}, for the runtime. */
export function evaluateGuard(workflow: ValidWorkflow, guard: GuardRef, scope: EdgeScope): boolean {
  const index = guard.params.edge;
  const edge = workflow.edges.find((e) => e.index === index);
  if (edge === undefined) return false;
  if (!edgeMatches(edge, scope)) return false;
  const reached =
    edge.limit !== undefined &&
    (scope.counts[edge.limit] ?? 0) >= (workflow.counters[edge.limit] ?? 0);
  if (guard.type === WORKFLOW_GUARDS.limitReached) return reached;
  if (guard.type === WORKFLOW_GUARDS.edge) return !reached;
  return false;
}
