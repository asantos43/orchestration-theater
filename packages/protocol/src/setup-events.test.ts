// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';

describe('setup events (P4 of docs/18)', () => {
  it('[proposta] validates the five payloads, strictly', () => {
    const base = { runId: 'SR1', flow: 'first_run' };
    const started = { ...base, step: 'detect' };
    const step = { ...base, step: 'detect', next: 'preset' };
    const back = { ...base, step: 'preset' };
    const confirmed = {
      ...base,
      preset: 'quality',
      executors: ['minimax-m2-medium@opencode/minimax-api'],
      written: ['roles.preset', 'executors.minimax-m2-medium@opencode/minimax-api'],
    };
    const cancelled = { ...base, step: 'review' };
    expect(validateEventPayload('setup.started', 1, started)).toEqual(started);
    expect(validateEventPayload('setup.step', 1, step)).toEqual(step);
    expect(validateEventPayload('setup.back', 1, back)).toEqual(back);
    expect(validateEventPayload('setup.confirmed', 1, confirmed)).toEqual(confirmed);
    expect(validateEventPayload('setup.cancelled', 1, cancelled)).toEqual(cancelled);
    expect(
      validateEventPayload('setup.confirmed', 1, { ...confirmed, preset: null }),
    ).toMatchObject({ preset: null });
    for (const [type, payload] of [
      ['setup.started', { ...started, apiKey: 'x' }],
      ['setup.started', { ...started, runId: 'run-1' }],
      ['setup.step', { ...step, next: 'finish' }],
      ['setup.back', { ...back, flow: 'other' }],
      ['setup.confirmed', { ...confirmed, preset: 'cheap' }],
      ['setup.cancelled', { ...cancelled, step: 'nowhere' }],
    ] as const) {
      expect(() => validateEventPayload(type, 1, payload)).toThrow();
    }
  });
});
