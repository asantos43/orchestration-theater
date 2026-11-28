// SPDX-License-Identifier: MPL-2.0
import type { PlayContext } from '../../../pipeline/context.js';
import type { PlayState } from '../../../pipeline/definitions.js';
import type { PlayEffect } from '../../../pipeline/effects.js';
import type { StepContext, StepResult, StepRunner } from '../types.js';
import { PLAY_STEP_MODULES, stateOfNode, type PlayStepModule } from './modules.js';

/**
 * The door of the play steps to the stage code (plan of Phase 11b, P3). [proposta] A port of the
 * engine, like `ToolCaller` of `call_tool`: the runtime does not know the play runner, and the
 * tests give it a fake. The adapter over `PlayRunner` and the handler of
 * `orchestration/play-effects.ts` is wired by whoever starts a play as a run of the engine (P10);
 * until then the `PlayRunner` drives the same stages event by event, and these runners are what a
 * run of the generic runtime would call.
 */
export interface PlayStageHost {
  /** The context of the play the run stands for (the machine's, as `PlayRunner` keeps it). */
  contextOf(runId: string): Promise<PlayContext>;
  /**
   * Runs the effects of one stage and says how the stage ended, as the typed output the edges that
   * leave the node read (`output.approved`, `output.valid`...). A failure of the stage is a
   * `failed` result; the host never throws for it.
   */
  runStage(call: {
    readonly runId: string;
    readonly state: PlayState;
    readonly effects: readonly PlayEffect[];
    readonly signal: AbortSignal;
  }): Promise<StepResult>;
}

function runnerOf(module: PlayStepModule, host: PlayStageHost): StepRunner {
  return {
    type: module.type,
    async run(ctx: StepContext): Promise<StepResult> {
      const state = stateOfNode(ctx.node);
      if (!module.states.includes(state)) {
        return {
          kind: 'failed',
          reason: 'play_state_unknown',
          detail: `the node "${ctx.node}" is not a state of the step type ${module.type}`,
        };
      }
      const context = await host.contextOf(ctx.runId);
      return host.runStage({
        runId: ctx.runId,
        state,
        effects: module.effects(state, context),
        signal: ctx.signal,
      });
    },
  };
}

/** The runners of the play step types, over one host. Add them to `GENERIC_STEP_RUNNERS` to run a play. */
export function createPlayStepRunners(host: PlayStageHost): readonly StepRunner[] {
  return PLAY_STEP_MODULES.map((module) => runnerOf(module, host));
}
