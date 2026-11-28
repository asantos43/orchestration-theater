// SPDX-License-Identifier: MPL-2.0
import type { PlayContext } from '../../../pipeline/context.js';
import type { PlayState } from '../../../pipeline/definitions.js';
import { entryEffects, type PlayEffect } from '../../../pipeline/effects.js';

/**
 * The step types of the play (plan of Phase 11b, P3): `plan`, `clarify`, `review`, `script`,
 * `execute_dag`, `integrate`, `critique`, `decide` and `deliver`, plus `await_producer`, the node
 * that stands for the fixed menu of AWAITING_PRODUCER. Each module wraps the stage code that
 * already exists: what a stage asks the world to do is `entryEffects` of `pipeline/effects.ts` (the
 * same function the machine runs on entry and `PlayRunner.resume` runs after a restart), and the
 * long work is done by the handler of `orchestration/play-effects.ts`, which comes back as an event.
 * Nothing of the stages is written again here. [proposta] The shape of the module; the plan fixes
 * only the names of the types.
 *
 * The specs of the types (params, typed output, role, effects) are the ones of `PLAY_STEP_TYPES` in
 * `@otheater/workflows`, which the validator reads; a module only says which states of the machine
 * its type stands for.
 */

export const PLAY_STEP_TYPE_IDS = [
  'plan',
  'clarify',
  'review',
  'script',
  'execute_dag',
  'integrate',
  'critique',
  'decide',
  'deliver',
  'await_producer',
] as const;
export type PlayStepTypeId = (typeof PLAY_STEP_TYPE_IDS)[number];

export interface PlayStepModule {
  /** The id of the step type, the `step` of a node of `play.yaml`. */
  readonly type: PlayStepTypeId;
  /** The states of the machine whose node uses this type (`review` has two). */
  readonly states: readonly PlayState[];
  /** What a visit to `state` asks the world to do (never empty for a stage that runs a role). */
  effects(state: PlayState, context: PlayContext): PlayEffect[];
}

function module_(type: PlayStepTypeId, states: readonly PlayState[]): PlayStepModule {
  return {
    type,
    states,
    effects(state, context) {
      if (!states.includes(state)) {
        throw new RangeError(`the step type ${type} does not stand for the state ${state}`);
      }
      return entryEffects(state, context);
    },
  };
}

export const PLAY_STEP_MODULES: readonly PlayStepModule[] = [
  module_('plan', ['PLANNING']),
  module_('clarify', ['CLARIFYING']),
  module_('review', ['REVIEWING_PLAN', 'REVIEWING_SCRIPT']),
  module_('script', ['SCRIPTING']),
  module_('execute_dag', ['EXECUTING']),
  module_('integrate', ['INTEGRATING']),
  module_('critique', ['CRITIQUING']),
  module_('decide', ['DECIDING']),
  module_('deliver', ['DELIVERING']),
  module_('await_producer', ['AWAITING_PRODUCER']),
];

/** The module of a step type, or `undefined` for a type that is not of the play. */
export function playStepModule(type: string): PlayStepModule | undefined {
  return PLAY_STEP_MODULES.find((candidate) => candidate.type === type);
}

/** The state of the machine a node of `play.yaml` stands for (the id of the node in upper case). */
export function stateOfNode(node: string): PlayState {
  return node.toUpperCase() as PlayState;
}
