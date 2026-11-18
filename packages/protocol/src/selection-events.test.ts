// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';

const skipped = {
  executor: 'claude-opus-high@claude-code/empresa',
  profile: 'claude-code/empresa',
  reason: 'quota',
  detail: 'exhausted',
  untilReset: 5_000,
};

const selected = {
  role: 'author',
  playId: 'P1',
  outcome: 'selected',
  executor: 'codex-sol-high@codex/conta-1',
  profile: 'codex/conta-1',
  strategy: 'ordered',
  retriedAfter: null,
  crossCheck: {
    mode: 'prefer_other_provider',
    applied: false,
    workedProvider: null,
    fellBack: false,
    blocked: false,
  },
  skipped: [skipped],
  waiting: null,
  occurredAt: 1_000,
};

const waiting = {
  ...selected,
  outcome: 'waiting',
  executor: null,
  profile: null,
  waiting: { mode: 'next', on: [skipped.executor], until: 5_000, notify: false },
};

describe('executor.selected event [proposta]', () => {
  it('accepts a selection, with the skipped list always present', () => {
    expect(validateEventPayload('executor.selected', 1, selected)).toEqual(selected);
    const first = { ...selected, skipped: [] };
    expect(validateEventPayload('executor.selected', 1, first)).toEqual(first);
  });

  it('accepts a wait, with nothing to wait for and with no end known', () => {
    expect(validateEventPayload('executor.selected', 1, waiting)).toEqual(waiting);
    const nothing = { ...waiting, waiting: { mode: 'next', on: [], until: null, notify: true } };
    expect(validateEventPayload('executor.selected', 1, nothing)).toEqual(nothing);
  });

  it('accepts every reason of 5.7 and the three the algorithm adds', () => {
    for (const reason of [
      'quota',
      'budget',
      'draining',
      'invalid',
      'no_slot',
      'ram',
      'context',
      'same_provider',
      'same_model',
      'unhealthy',
      'retry',
    ]) {
      const payload = { ...selected, skipped: [{ ...skipped, reason }] };
      expect(validateEventPayload('executor.selected', 1, payload)).toEqual(payload);
    }
  });

  it('refuses an unknown reason, strategy or cross-check mode', () => {
    const bad = (patch: object) => () =>
      validateEventPayload('executor.selected', 1, { ...selected, ...patch });
    expect(bad({ skipped: [{ ...skipped, reason: 'tired' }] })).toThrow();
    expect(bad({ strategy: 'random' })).toThrow();
    expect(bad({ crossCheck: { ...selected.crossCheck, mode: 'strict' } })).toThrow();
  });

  it('refuses a selection without the Executor, and a wait with one', () => {
    expect(() =>
      validateEventPayload('executor.selected', 1, { ...selected, executor: null, profile: null }),
    ).toThrow();
    expect(() =>
      validateEventPayload('executor.selected', 1, { ...waiting, executor: selected.executor }),
    ).toThrow();
  });

  it('refuses a selection with a wait, and a wait without it', () => {
    expect(() =>
      validateEventPayload('executor.selected', 1, { ...selected, waiting: waiting.waiting }),
    ).toThrow();
    expect(() =>
      validateEventPayload('executor.selected', 1, { ...waiting, waiting: null }),
    ).toThrow();
  });

  it('refuses a missing skipped list, a negative time and extra fields', () => {
    const missing: Partial<typeof selected> = { ...selected };
    delete missing.skipped;
    expect(() => validateEventPayload('executor.selected', 1, missing)).toThrow();
    expect(() =>
      validateEventPayload('executor.selected', 1, {
        ...selected,
        skipped: [{ ...skipped, untilReset: -1 }],
      }),
    ).toThrow();
    expect(() => validateEventPayload('executor.selected', 1, { ...selected, extra: 1 })).toThrow();
    expect(() =>
      validateEventPayload('executor.selected', 1, {
        ...selected,
        skipped: [{ ...skipped, extra: 1 }],
      }),
    ).toThrow();
  });
});
