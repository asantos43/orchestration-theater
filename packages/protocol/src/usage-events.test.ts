// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';

const priced = {
  usageId: 'U1',
  sessionId: 'S1',
  playId: 'P1',
  profile: 'claude-code/work',
  executor: 'claude-opus-high@claude-code/work',
  model: 'claude-opus-5-5',
  inputTokens: 1000,
  outputTokens: 200,
  cachedTokens: 0,
  costUsd: 0.008,
  costKind: 'real',
  costSource: 'pricing_table',
  pricingVersion: '2026-11-18',
  occurredAt: 1_000,
};

describe('usage.recorded event [proposta]', () => {
  it('accepts a priced turn and a turn whose cost is unknown (null, never 0)', () => {
    expect(validateEventPayload('usage.recorded', 1, priced)).toEqual(priced);
    const unknown = {
      ...priced,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      costKind: null,
      costSource: null,
      pricingVersion: null,
      playId: null,
    };
    expect(validateEventPayload('usage.recorded', 1, unknown)).toEqual(unknown);
  });

  it('refuses an unknown cost source or kind, a negative cost and extra fields', () => {
    expect(() =>
      validateEventPayload('usage.recorded', 1, { ...priced, costSource: 'provider_billing' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('usage.recorded', 1, { ...priced, costKind: 'estimate' }),
    ).toThrow();
    expect(() => validateEventPayload('usage.recorded', 1, { ...priced, costUsd: -1 })).toThrow();
    expect(() => validateEventPayload('usage.recorded', 1, { ...priced, extra: 1 })).toThrow();
    const { costUsd: _omitted, ...missing } = priced;
    expect(() => validateEventPayload('usage.recorded', 1, missing)).toThrow();
  });
});
