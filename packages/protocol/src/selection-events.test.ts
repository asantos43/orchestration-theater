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

const waitOn = [
  { executor: 'claude-opus-high@claude-code/a', profile: 'claude-code/a', reason: 'quota' },
];

describe('the wait events of P16b [proposta]', () => {
  const directorWaiting = {
    scenarioId: 'S1',
    on: waitOn,
    until: 9_000,
    message: 'waiting for quota of claude-code/a',
    since: 1_000,
  };
  const demandWaiting = {
    scenarioId: 'S1',
    playId: 'P1',
    demandId: 'd1',
    role: 'author',
    on: waitOn,
    until: null,
    message: 'waiting for quota of claude-code/a',
    since: 1_000,
    holdsSlot: false,
  };

  it('accepts the wait and the return of the Director', () => {
    expect(validateEventPayload('scenario.director_waiting', 1, directorWaiting)).toEqual(
      directorWaiting,
    );
    const resumed = {
      scenarioId: 'S1',
      outcome: 'selected',
      executor: 'codex-sol-high@codex/b',
      waitedMs: 4_000,
    };
    expect(validateEventPayload('scenario.director_resumed', 1, resumed)).toEqual(resumed);
    const cancelled = { ...resumed, outcome: 'cancelled', executor: null };
    expect(validateEventPayload('scenario.director_resumed', 1, cancelled)).toEqual(cancelled);
  });

  it('accepts the wait and the return of a demand', () => {
    expect(validateEventPayload('demand.waiting', 1, demandWaiting)).toEqual(demandWaiting);
    const resumed = {
      scenarioId: null,
      playId: 'P1',
      demandId: 'd1',
      role: 'author',
      outcome: 'unavailable',
      executor: null,
      waitedMs: 0,
      holdsSlot: true,
    };
    expect(validateEventPayload('demand.resumed', 1, resumed)).toEqual(resumed);
  });

  it('refuses an unknown field, a reason or an outcome the wait does not know', () => {
    const extra = { ...directorWaiting, extra: 1 };
    expect(() => validateEventPayload('scenario.director_waiting', 1, extra)).toThrow();
    const reason = { ...demandWaiting, on: [{ ...waitOn[0], reason: 'weather' }] };
    expect(() => validateEventPayload('demand.waiting', 1, reason)).toThrow();
    const outcome = { ...demandWaiting, outcome: 'waiting', holdsSlot: true };
    expect(() => validateEventPayload('demand.resumed', 1, outcome)).toThrow();
    expect(() =>
      validateEventPayload('demand.waiting', 1, { ...demandWaiting, holdsSlot: 'no' }),
    ).toThrow();
  });

  it('accepts the selection_wait notice of the chat and refuses a loose one', () => {
    const notice = {
      scenarioId: 'S1',
      kind: 'selection_wait',
      role: 'reviewer',
      playId: 'P1',
      demandId: 'd1',
      crossCheck: 'require_other_provider',
      workedProvider: 'anthropic',
      on: [
        {
          executor: 'claude-opus-high@claude-code/a',
          profile: 'claude-code/a',
          reason: 'same_provider',
        },
      ],
      until: null,
    };
    expect(validateEventPayload('scenario.system_message', 1, notice)).toEqual(notice);
    expect(() =>
      validateEventPayload('scenario.system_message', 1, { ...notice, extra: true }),
    ).toThrow();
  });
});

describe('the play notice of P16b [proposta]', () => {
  const notice = {
    scenarioId: 'S1',
    playId: 'P1',
    kind: 'delivery_unanswered',
    detail: 'timeout',
  };

  it('accepts a notice with or without a scenario and a detail', () => {
    expect(validateEventPayload('play.notice', 1, notice)).toEqual(notice);
    const bare = { ...notice, scenarioId: null, detail: null };
    expect(validateEventPayload('play.notice', 1, bare)).toEqual(bare);
  });

  it('refuses a kind it does not know, a long detail and a loose field', () => {
    expect(() => validateEventPayload('play.notice', 1, { ...notice, kind: 'weather' })).toThrow();
    expect(() =>
      validateEventPayload('play.notice', 1, { ...notice, detail: 'x'.repeat(501) }),
    ).toThrow();
    expect(() => validateEventPayload('play.notice', 1, { ...notice, extra: 1 })).toThrow();
  });
});
