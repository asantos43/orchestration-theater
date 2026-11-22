// SPDX-License-Identifier: MPL-2.0
import type { RoleId } from '../registries/roles.js';

/**
 * The steps of the official `play` flow (architecture 5.4) as the registry of the flows names them
 * (plan of Phase 9, P12, N133/N241). A flow of the configuration (`flows.<id>`) is the `play` with
 * some of these steps on or off, plus the limits of each step: it never adds a step, never
 * reorders them and never names a tool or a permission. The order below is the order of the play
 * and is fixed; `steps` of a flow is a map, so the file cannot say a different order.
 *
 * This module is pure (no zod, no `node:`): the schema is in `config.ts`.
 */

/** The steps, in the order of the play. */
export const FLOW_STEP_IDS = [
  'planning',
  'clarifying',
  'plan_review',
  'scripting',
  'script_review',
  'execution',
  'integration',
  'critique',
  'delivery',
] as const;
export type FlowStepId = (typeof FLOW_STEP_IDS)[number];

/**
 * The counters a step can limit (the keys of `limits` of 5.4 that belong to one step). `submit_retries`
 * is not here: it is counted by the session of any stage (N79), so it has no step to belong to and
 * stays a global key of `limits` [proposta].
 */
export const FLOW_LIMIT_KEYS = [
  'plan_reviews',
  'critic_rejections',
  'attempts_per_demand',
  'script_validations',
  'script_vetoes',
  'script_returns',
  'structural_restarts',
] as const;
export type FlowLimitKey = (typeof FLOW_LIMIT_KEYS)[number];

export interface FlowStepDefinition {
  readonly id: FlowStepId;
  /**
   * `true`: the flow may turn the step off. The mandatory steps are the loop counters, the code
   * verification and the delivery (N241): the planning that feeds them, the script, its review,
   * the execution with its `verify`, the integration and the delivery.
   */
  readonly optional: boolean;
  /**
   * The role that runs the step (5.4). `null` for a step the daemon runs without a role. A flow
   * may only repeat it: swapping the role would change what the stage is allowed to do, and a
   * flow never releases a permission [proposta].
   */
  readonly role: RoleId | null;
  /** The limits the step owns; each limit key belongs to exactly one step. */
  readonly limits: readonly FlowLimitKey[];
}

export const FLOW_STEPS: Readonly<Record<FlowStepId, FlowStepDefinition>> = {
  planning: { id: 'planning', optional: false, role: 'author', limits: [] },
  clarifying: { id: 'clarifying', optional: false, role: 'director', limits: [] },
  plan_review: { id: 'plan_review', optional: true, role: 'reviewer', limits: ['plan_reviews'] },
  scripting: {
    id: 'scripting',
    optional: false,
    role: 'scriptwriter',
    limits: ['script_validations'],
  },
  script_review: {
    id: 'script_review',
    optional: false,
    role: 'author',
    limits: ['script_vetoes'],
  },
  execution: { id: 'execution', optional: false, role: 'actor', limits: ['attempts_per_demand'] },
  integration: { id: 'integration', optional: false, role: null, limits: ['script_returns'] },
  critique: {
    id: 'critique',
    optional: true,
    role: 'critic',
    limits: ['critic_rejections', 'structural_restarts'],
  },
  delivery: { id: 'delivery', optional: false, role: null, limits: [] },
};

/** The optional steps, in the order of the play. */
export const OPTIONAL_FLOW_STEP_IDS: readonly FlowStepId[] = FLOW_STEP_IDS.filter(
  (id) => FLOW_STEPS[id].optional,
);

export function isFlowStepId(value: string): value is FlowStepId {
  return (FLOW_STEP_IDS as readonly string[]).includes(value);
}
