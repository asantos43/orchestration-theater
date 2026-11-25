// SPDX-License-Identifier: MPL-2.0
import type { WorkflowDefinition } from '../definition.js';

/**
 * The play as a workflow definition, as data only (P1 of Phase 11b). P3 turns it into the `play`
 * 2.0 that replaces the hand-written machine (N311); until then it is the proof that the schema,
 * the validator and the compiler can carry the play. [proposta]
 *
 * - The nodes are the states of the machine of today, with `NEED` folded into the start.
 * - `inputs.skip_plan_review` and `inputs.skip_critique` are the optional steps of `flows.<id>`
 *   (N243), which P3 translates into params of the definition.
 * - The loops are bounded by the counters of today (`moderate` preset); when one is used up the run
 *   goes to the Producer, as the machine does. The choices of the Producer are bounded too
 *   (`producer_rounds`), so that every cycle has a limit.
 */
const toProducer = 'awaiting_producer';

export const PLAY_WORKFLOW: WorkflowDefinition = {
  id: 'play',
  version: '2.0.0',
  engine: '>=1 <2',
  description: 'The play: plan, script, execution by the Actors, critique and delivery.',
  inputs: {
    skip_plan_review: { type: 'boolean', default: false },
    skip_critique: { type: 'boolean', default: false },
  },
  nodes: {
    planning: { step: 'plan', role: 'director' },
    clarifying: { step: 'clarify' },
    reviewing_plan: { step: 'review', role: 'reviewer', params: { subject: 'plan' } },
    scripting: { step: 'script', role: 'scriptwriter' },
    reviewing_script: { step: 'review', role: 'reviewer', params: { subject: 'script' } },
    executing: { step: 'execute_dag', role: 'actor' },
    integrating: { step: 'integrate' },
    critiquing: { step: 'critique', role: 'critic' },
    deciding: { step: 'decide', role: 'director' },
    delivering: { step: 'deliver' },
    awaiting_producer: { step: 'await_producer' },
  },
  start: 'planning',
  edges: [
    'planning -> clarifying when output.has_open_questions',
    'planning -> scripting when inputs.skip_plan_review',
    'planning -> reviewing_plan',

    'clarifying -> scripting when inputs.skip_plan_review',
    'clarifying -> reviewing_plan',

    'reviewing_plan -> scripting when output.approved',
    { from: 'reviewing_plan', to: 'planning', limit: 'plan_reviews', on_limit: toProducer },

    'scripting -> reviewing_script when output.valid',
    { from: 'scripting', to: 'scripting', limit: 'script_validations', on_limit: toProducer },

    'reviewing_script -> executing when output.approved',
    { from: 'reviewing_script', to: 'scripting', limit: 'script_vetoes', on_limit: toProducer },

    'executing -> integrating when output.outcome == "completed"',
    {
      from: 'executing',
      to: 'scripting',
      when: 'output.outcome == "restart_script"',
      limit: 'script_returns',
      on_limit: toProducer,
    },
    {
      from: 'executing',
      to: 'planning',
      when: 'output.outcome == "restart_plan"',
      limit: 'structural_restarts',
      on_limit: toProducer,
    },

    'integrating -> delivering when output.ok and inputs.skip_critique',
    'integrating -> critiquing when output.ok',
    'integrating -> awaiting_producer',

    'critiquing -> delivering when output.approved',
    { from: 'critiquing', to: 'deciding', limit: 'critic_rejections', on_limit: toProducer },

    'deciding -> scripting when output.decision == "script"',
    'deciding -> executing when output.decision == "execution"',
    'deciding -> awaiting_producer',

    'delivering -> done when output.outcome == "delivered"',
    'delivering -> awaiting_producer',

    ...(['plan', 'script', 'execution', 'deliver'] as const).map((choice) => ({
      from: toProducer,
      to: { plan: 'planning', script: 'scripting', execution: 'executing', deliver: 'delivering' }[
        choice
      ],
      when: `output.choice == "${choice}"`,
      limit: 'producer_rounds',
      on_limit: 'cancelled',
    })),
    'awaiting_producer -> cancelled',
  ],
  limits: {
    plan_reviews: 2,
    script_validations: 3,
    script_vetoes: 2,
    script_returns: 2,
    structural_restarts: 1,
    critic_rejections: 2,
    producer_rounds: 20,
  },
};
