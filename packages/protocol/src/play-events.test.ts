// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  FINAL_PLAY_STATES,
  PLAY_STATES,
  PlayCreatedPayloadSchema,
  PlayTransitionedPayloadSchema,
  isFinalPlayState,
} from './play-events.js';

describe('the payloads of the play events', () => {
  it('takes a created play and a transition the way the daemon writes them', () => {
    const created = {
      flowId: 'play',
      flowVersion: 1,
      need: 'write alpha',
      parentPlayId: null,
    };
    expect(PlayCreatedPayloadSchema.parse(created)).toEqual(created);
    const transitioned = {
      event: 'START',
      from: 'NEED',
      to: 'PLANNING',
      counters: { attempts: 0 },
      effects: ['startPlanning'],
    };
    expect(PlayTransitionedPayloadSchema.parse(transitioned)).toEqual(transitioned);
    expect(PlayTransitionedPayloadSchema.parse({ ...transitioned, reason: 'why' }).reason).toBe(
      'why',
    );
  });

  it('refuses a state that is not one of the machine, a missing field and a stray one', () => {
    const transitioned = { event: 'X', from: 'NEED', to: 'PLANNING', counters: {}, effects: [] };
    expect(PlayTransitionedPayloadSchema.safeParse({ ...transitioned, to: 'LUNCH' }).success).toBe(
      false,
    );
    expect(PlayTransitionedPayloadSchema.safeParse({ ...transitioned, extra: 1 }).success).toBe(
      false,
    );
    expect(
      PlayTransitionedPayloadSchema.safeParse({ ...transitioned, effects: undefined }).success,
    ).toBe(false);
    expect(
      PlayCreatedPayloadSchema.safeParse({ flowId: 'play', flowVersion: 0, need: 'x' }).success,
    ).toBe(false);
  });

  it('knows the final states', () => {
    expect([...FINAL_PLAY_STATES]).toEqual(['DONE', 'CANCELLED']);
    for (const state of PLAY_STATES) {
      expect(isFinalPlayState(state)).toBe(state === 'DONE' || state === 'CANCELLED');
    }
  });
});
