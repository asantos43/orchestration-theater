// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the play machine only (excluded from the build of the package).
import { initialTransition, transition, type SnapshotFrom } from 'xstate';
import { LIMIT_PRESETS, type LimitPresetName, type PlayLimits } from '../config.js';
import type { PlayContext, PlayFlowRef } from './context.js';
import type { PlayState } from './definitions.js';
import type { PlayEffect } from './effects.js';
import type { PlayEvent } from './events.js';
import { playMachine, type PlayDecision } from './machine.js';

export const PRESETS: readonly LimitPresetName[] = ['economical', 'moderate', 'persistent'];

export function limitsOf(preset: LimitPresetName, overrides: Partial<PlayLimits> = {}): PlayLimits {
  return { ...LIMIT_PRESETS[preset], ...overrides };
}

/**
 * The pure machine driven by hand: `send` takes a transition and keeps what it asked for (the
 * effects of the last step, every decision) so a test can read it. The clock is a plain counter
 * that moves only when the test says so.
 */
export class Model {
  snapshot: SnapshotFrom<typeof playMachine>;
  /** The effects the last `send` asked for, in order. */
  effects: PlayEffect[] = [];
  /** Every decision recorded so far. */
  decisions: PlayDecision[] = [];
  now = 1_000_000;

  constructor(limits: PlayLimits = limitsOf('moderate'), need = 'a need', flow?: PlayFlowRef) {
    [this.snapshot] = initialTransition(playMachine, { playId: 'p1', need, limits, flow });
  }

  get state(): PlayState {
    return this.snapshot.value;
  }

  get context(): PlayContext {
    return this.snapshot.context;
  }

  counter(name: string): number {
    return this.context.counters[name] ?? 0;
  }

  can(event: PlayEvent): boolean {
    return this.snapshot.can({ ...event, at: this.now });
  }

  send(event: PlayEvent): this {
    const machineEvent = { ...event, at: this.now };
    if (!this.snapshot.can(machineEvent)) {
      throw new Error(`${this.state} does not take ${event.type}`);
    }
    const [next, actions] = transition(playMachine, this.snapshot, machineEvent);
    this.snapshot = next;
    this.effects = [];
    for (const action of actions) {
      const params = action.params as
        { effects?: PlayEffect[]; decision?: PlayDecision } | undefined;
      if (action.type === 'emit' && params?.effects !== undefined) {
        this.effects.push(...params.effects);
      }
      if (action.type === 'record' && params?.decision !== undefined) {
        this.decisions.push(params.decision);
      }
    }
    return this;
  }

  effectTypes(): string[] {
    return this.effects.map((effect) => effect.type);
  }

  effect<T extends PlayEffect['type']>(type: T): Extract<PlayEffect, { type: T }> {
    const found = this.effects.find((effect) => effect.type === type);
    if (found === undefined)
      throw new Error(`no ${type} effect in ${this.effectTypes().join(',')}`);
    return found as Extract<PlayEffect, { type: T }>;
  }

  // ---- paths through the machine -------------------------------------------------------------

  /** NEED -> PLANNING. */
  start(dispenseCritic?: string): this {
    return this.send(
      dispenseCritic === undefined
        ? { type: 'START' }
        : { type: 'START', dispenseCritic: { reason: dispenseCritic } },
    );
  }

  /** -> SCRIPTING, with the plan approved. */
  toScripting(): this {
    if (this.state === 'NEED') this.start();
    this.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    // a flow without the review of the plan (P12) is already in SCRIPTING
    return this.state === 'SCRIPTING' ? this : this.send({ type: 'PLAN_REVIEWED', approved: true });
  }

  /** -> EXECUTING, with a valid script of these demands. */
  toExecuting(demandIds: readonly string[] = ['d1', 'd2']): this {
    return this.toScripting()
      .send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: [...demandIds] })
      .send({ type: 'SCRIPT_REVIEWED', approved: true });
  }

  /** Approves every demand that is still pending; the last one leaves EXECUTING. */
  approveAll(): this {
    for (const demandId of [...this.context.demandIds]) {
      if (this.state !== 'EXECUTING') break;
      if (!this.context.approvedDemands.includes(demandId)) {
        this.send({ type: 'DEMAND_APPROVED', demandId });
      }
    }
    return this;
  }

  /** -> CRITIQUING (or DELIVERING when the Critic is waived). */
  toCritiquing(demandIds: readonly string[] = ['d1', 'd2']): this {
    return this.toExecuting(demandIds).approveAll().send({ type: 'INTEGRATED', ok: true });
  }

  /** -> DECIDING: the Critic rejected. */
  toDeciding(reason = 'not good enough'): this {
    if (this.state !== 'CRITIQUING') this.toCritiquing();
    return this.send({ type: 'CRITIQUED', approved: false, reason });
  }

  /** The Director classifies the critique (judgment point 1). */
  classify(failures: object[]): this {
    return this.send({
      type: 'JUDGED',
      point: 'classify_critique',
      answer: { failures } as never,
    });
  }
}
