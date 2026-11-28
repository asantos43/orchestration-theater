// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_GUARDS,
  compileWorkflow,
  evaluateGuard,
  type EdgeScope,
  type ValidWorkflow,
} from '@otheater/workflows';
import { assign, setup, type AnyStateMachine } from 'xstate';

/**
 * The XState machine of a workflow (docs/24 §6; plan of Phase 11b, P2). The shape comes from the
 * compiler of P1 (`compileWorkflow`, pure data); here the runtime gives it the guards and the
 * actions by the names the compiler fixes. Every action is a pure `assign`, so the driver can use
 * the pure `transition()` and write the result in one transaction, as the `PlayRunner` does.
 */

/** Why a run went to `failed` (or hit a limit on its way). */
export interface RunFailure {
  readonly kind: 'step_failed' | 'no_edge' | 'limit';
  readonly node?: string;
  readonly reason: string;
}

/** The context of the machine: what the guards read, and the count of every limited edge. */
export interface RunContext {
  /** The inputs of the run, with the defaults filled in. */
  readonly inputs: JsonObject;
  /** How many times each limited edge was taken, by limit key. */
  readonly counts: Readonly<Record<string, number>>;
  readonly failure: RunFailure | null;
}

/** What the driver sends the machine. */
export type RunEvent =
  | { readonly type: 'workflow.step.done'; readonly output: JsonObject }
  | { readonly type: 'workflow.step.failed'; readonly reason: string; readonly detail?: string }
  | { readonly type: 'workflow.cancel'; readonly reason?: string };

export interface RunMachineInput {
  readonly inputs: JsonObject;
}

function scopeOf(context: RunContext, event: RunEvent): EdgeScope {
  return {
    output: event.type === 'workflow.step.done' ? event.output : undefined,
    inputs: context.inputs,
    counts: context.counts,
  };
}

/** Builds the machine of a valid workflow. The same workflow gives the same machine. */
export function buildWorkflowMachine(workflow: ValidWorkflow): AnyStateMachine {
  const config = compileWorkflow(workflow);
  const guardOf =
    (type: string) =>
    ({ context, event }: { context: RunContext; event: RunEvent }, params: { edge: number }) =>
      evaluateGuard(workflow, { type, params }, scopeOf(context, event));
  const setupMachine = setup({
    // The assertion is what gives `setup` its types (the rule cannot see the inference).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    types: {} as { context: RunContext; events: RunEvent; input: RunMachineInput },
    guards: {
      [WORKFLOW_GUARDS.edge]: guardOf(WORKFLOW_GUARDS.edge),
      [WORKFLOW_GUARDS.limitReached]: guardOf(WORKFLOW_GUARDS.limitReached),
    },
    actions: {
      [WORKFLOW_ACTIONS.count]: assign(({ context }, params: { limit: string }) => ({
        counts: { ...context.counts, [params.limit]: (context.counts[params.limit] ?? 0) + 1 },
      })),
      [WORKFLOW_ACTIONS.limitHit]: assign((_args, params: { edge: number; limit: string }) => ({
        failure: { kind: 'limit', reason: `limit_reached:${params.limit}` } satisfies RunFailure,
      })),
      [WORKFLOW_ACTIONS.noEdge]: assign((_args, params: { node: string }) => ({
        failure: { kind: 'no_edge', node: params.node, reason: 'no_edge' } satisfies RunFailure,
      })),
      [WORKFLOW_ACTIONS.stepFailed]: assign(({ event }, params: { node: string }) => ({
        failure: {
          kind: 'step_failed',
          node: params.node,
          reason: event.type === 'workflow.step.failed' ? event.reason : 'step_failed',
        } satisfies RunFailure,
      })),
    },
  });
  // The compiler's config is plain data typed for no machine in particular: the cast is the seam.
  return setupMachine.createMachine({
    ...config,
    context: ({ input }: { input: RunMachineInput }): RunContext => ({
      inputs: input.inputs,
      counts: {},
      failure: null,
    }),
  } as never) as unknown as AnyStateMachine;
}
