// SPDX-License-Identifier: MPL-2.0
import { DELIVERY_MODES } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { type DeliveryPolicyInput, resolveDeliveryMode } from './delivery-policy.js';

const base: DeliveryPolicyInput = {
  configMode: 'pr',
  allowDirectMerge: false,
  attended: true,
};

describe('resolveDeliveryMode (architecture 5.5, N5)', () => {
  it('opens a PR by default and says the global config asked for it', () => {
    expect(resolveDeliveryMode(base)).toEqual({
      mode: 'pr',
      requestedMode: 'pr',
      requestedBy: 'config',
      downgraded: false,
    });
  });

  it('turns direct_merge and ask into a PR without allow_direct_merge', () => {
    for (const mode of ['direct_merge', 'ask'] as const) {
      const decision = resolveDeliveryMode({
        ...base,
        requested: { mode, by: 'play' },
        allowDirectMerge: false,
      });
      expect(decision).toEqual({
        mode: 'pr',
        requestedMode: mode,
        requestedBy: 'play',
        downgraded: true,
        reason: 'direct_merge_not_allowed',
      });
    }
  });

  it('merges directly only when allowed AND the play, the task or the Producer asked', () => {
    for (const by of ['play', 'task', 'producer'] as const) {
      const decision = resolveDeliveryMode({
        ...base,
        allowDirectMerge: true,
        requested: { mode: 'direct_merge', by },
      });
      expect(decision).toMatchObject({ mode: 'direct_merge', requestedBy: by, downgraded: false });
    }
  });

  it('does not merge directly when only the global config or the project asked for it', () => {
    for (const by of ['config', 'project'] as const) {
      const decision = resolveDeliveryMode({
        ...base,
        allowDirectMerge: true,
        requested: { mode: 'direct_merge', by },
      });
      expect(decision).toMatchObject({
        mode: 'pr',
        downgraded: true,
        reason: 'direct_merge_not_requested_by_play_or_task',
      });
    }
    // The config key alone, with no request on the play, is read the same way.
    expect(
      resolveDeliveryMode({ ...base, configMode: 'direct_merge', allowDirectMerge: true }),
    ).toMatchObject({ mode: 'pr', requestedMode: 'direct_merge', requestedBy: 'config' });
  });

  it('asks the Producer when someone is looking, and opens a PR when nobody is', () => {
    const allowed = { ...base, configMode: 'ask', allowDirectMerge: true } as const;
    expect(resolveDeliveryMode({ ...allowed, attended: true })).toMatchObject({
      mode: 'ask',
      downgraded: false,
    });
    expect(resolveDeliveryMode({ ...allowed, attended: false })).toMatchObject({
      mode: 'pr',
      downgraded: true,
      reason: 'unattended',
    });
  });

  it('a request overrides the global mode', () => {
    expect(
      resolveDeliveryMode({
        ...base,
        configMode: 'direct_merge',
        requested: { mode: 'pr', by: 'task' },
      }),
    ).toMatchObject({ mode: 'pr', requestedBy: 'task', downgraded: false });
  });

  it('never returns a mode outside the three of the config key', () => {
    for (const configMode of DELIVERY_MODES) {
      for (const allowDirectMerge of [true, false]) {
        for (const attended of [true, false]) {
          const decision = resolveDeliveryMode({ configMode, allowDirectMerge, attended });
          expect(DELIVERY_MODES).toContain(decision.mode);
        }
      }
    }
  });
});
