// SPDX-License-Identifier: MPL-2.0
import { pendingDemands, type PlayContext, type ProducerReason } from './context.js';
import type { MenuOption, PlayState } from './definitions.js';
import type { JudgmentPointId } from './judgment.js';
import { availableMenu } from './menu.js';

/**
 * What the machine asks the world to do (architecture 5.4: "efeitos longos ficam fora da
 * máquina e voltam como eventos"). The machine only describes the work; the {@link PlayEffects}
 * handler (wired by the step that runs the sessions, P8) starts it, and the result comes back as
 * an event through `PlayRunner.send`. Every effect is at-least-once: after a restart the runner
 * asks again for the work of the state the play is in, so a handler must be idempotent.
 */
export type PlayEffect =
  | {
      /** A stage run by one role: plan, review, script, critique... */
      readonly type: 'run_stage';
      readonly stage: PlayState;
      readonly role: string;
      /** Why the stage runs again (the rejection, the veto, the failure), when it does. */
      readonly feedback: string | null;
      /** PLANNING only: the plan starts over (structural restart or new need). */
      readonly restart: boolean;
      /** How many invalid `submit` outputs the session may send back to the Executor (N79). */
      readonly submitRetries: number;
    }
  | {
      /** Run the demands of the script (the DAG scheduler lives in the handler). */
      readonly type: 'run_demands';
      readonly demandIds: readonly string[];
      /** `same` is a plain (re)try; the others come from a judgment point of the Director. */
      readonly strategy:
        | 'same'
        | 'handoff'
        | 'reformulate'
        | 'switch_executor'
        | 'redo'
        /** [proposta] An attempt only to resolve a rebase conflict (N82, `resolve_attempt`). */
        | 'resolve';
      readonly retry: boolean;
      readonly feedback: string | null;
      readonly submitRetries: number;
    }
  | {
      /** Judgment point 2, "accept the partial work": it goes through `verify` like any demand. */
      readonly type: 'verify_demand';
      readonly demandId: string;
      readonly partial: boolean;
    }
  | {
      /** Judgment point 8, "rebase": rebase the worktrees of the dependents. */
      readonly type: 'rebase_dependents';
      readonly demandId: string;
      readonly dependentIds: readonly string[];
    }
  | {
      /** Ask the Director to settle a judgment point; the answer comes back as `JUDGED`. */
      readonly type: 'judge';
      readonly point: JudgmentPointId;
      readonly demandId: string | null;
      readonly dependentIds: readonly string[];
    }
  | { readonly type: 'integrate'; readonly demandIds: readonly string[] }
  | {
      readonly type: 'deliver';
      readonly demandIds: readonly string[];
      /** Only the approved demands: the PR says what was left out. */
      readonly partial: boolean;
      /** The PR says the Critic was waived. */
      readonly criticWaived: boolean;
      /** The Producer accepted the conflicts of a drifted base: no more drift check (N83). */
      readonly driftAccepted: boolean;
    }
  | {
      /** The fixed menu of AWAITING_PRODUCER, with the options that hold now. */
      readonly type: 'ask_menu';
      readonly options: readonly MenuOption[];
      readonly reason: ProducerReason | null;
    }
  | {
      /** Stop the work in flight (sessions, worktrees): the play left the state that asked for it. */
      readonly type: 'abort_work';
      readonly reason: string;
    };

export type PlayEffectType = PlayEffect['type'];

/** The play an effect belongs to. */
export interface PlayEffectScope {
  readonly playId: string;
  readonly scenarioId: string;
}

/**
 * The port the runner dispatches effects through. `dispatch` **starts** the work and resolves
 * when it has started; it must not wait for the work to finish (the runner serializes the
 * events of a play, and a long session would block them). The result comes back as an event.
 * A rejection is logged by the runner and does not undo the transition: the state is already
 * persisted, and `resume` asks again.
 */
export interface PlayEffects {
  dispatch(effect: PlayEffect, scope: PlayEffectScope): Promise<void>;
}

/** The role that runs each stage of the play (5.4, "Fronteira de cada papel"). */
export const STAGE_ROLES: Readonly<Partial<Record<PlayState, string>>> = {
  PLANNING: 'author',
  CLARIFYING: 'director',
  REVIEWING_PLAN: 'reviewer',
  SCRIPTING: 'scriptwriter',
  REVIEWING_SCRIPT: 'author',
  CRITIQUING: 'critic',
};

function submitRetries(context: PlayContext): number {
  return context.limits.submit_retries + (context.limitBonus.submit_retries ?? 0);
}

/**
 * The effects of being in a state, a pure function of the state and the context. The machine
 * runs it on entry, and `PlayRunner.resume` runs it again after a restart, so what a state asks
 * for is written once.
 */
export function entryEffects(state: PlayState, context: PlayContext): PlayEffect[] {
  const role = STAGE_ROLES[state];
  if (role !== undefined) {
    return [
      {
        type: 'run_stage',
        stage: state,
        role,
        feedback: context.feedback,
        restart: state === 'PLANNING' && context.restart,
        submitRetries: submitRetries(context),
      },
    ];
  }
  switch (state) {
    case 'EXECUTING': {
      // a demand that waits for the Director (an open judgment) is not started again
      const waiting = new Set(context.openJudgments.map((judgment) => judgment.demandId));
      const pending = pendingDemands(context).filter((id) => !waiting.has(id));
      return pending.length === 0
        ? []
        : [
            {
              type: 'run_demands',
              demandIds: pending,
              strategy: 'same',
              retry: context.feedback !== null,
              feedback: context.feedback,
              submitRetries: submitRetries(context),
            },
          ];
    }
    case 'INTEGRATING':
      return [{ type: 'integrate', demandIds: context.demandIds }];
    case 'DECIDING':
      return [{ type: 'judge', point: 'classify_critique', demandId: null, dependentIds: [] }];
    case 'DELIVERING':
      return [
        {
          type: 'deliver',
          demandIds: context.deliverOnlyApproved ? context.approvedDemands : context.demandIds,
          partial: context.deliverOnlyApproved,
          criticWaived: context.criticWaived,
          driftAccepted: context.driftAccepted === true,
        },
      ];
    case 'AWAITING_PRODUCER':
      return [
        { type: 'ask_menu', options: availableMenu(context), reason: context.producerReason },
      ];
    default:
      return [];
  }
}
