// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { validateEventPayload } from './events.js';
import { PACKAGE_SUMMARIES } from './session-events.js';

const from = { client: 'claude-code', profile: 'work', model: 'opus', effort: 'high' };
const to = { client: 'codex', profile: 'personal', model: 'gpt' };
const correlation = { playId: 'p1', demandId: 'd1', attemptId: 'a1' };

const handoff = {
  previousSessionId: 's1',
  role: 'actor',
  cause: 'quota_exhausted',
  from,
  to,
  countedAsAttempt: false,
  packageChars: 4200,
  packageLevel: 0,
  packageCut: false,
  summary: 'deterministic',
  ...correlation,
};

const failed = {
  sessionId: 's1',
  role: 'actor',
  cause: 'quota_exhausted',
  from,
  reason: 'waiting',
  on: ['gpt@codex/personal'],
  until: 1_763_521_200_000,
  ...correlation,
};

describe('the handoff events [proposta] (P18b, N146 and N147)', () => {
  it('session.handoff accepts the baton passed, with or without the optional fields', () => {
    expect(validateEventPayload('session.handoff', 1, handoff)).toEqual(handoff);
    const fallback = {
      ...handoff,
      cause: 'stuck',
      countedAsAttempt: true,
      packageLevel: 4,
      packageCut: true,
      summary: 'model_failed',
      summaryError: 'the model did not answer',
    };
    expect(validateEventPayload('session.handoff', 1, fallback)).toEqual(fallback);
    const bare = {
      cause: 'client_crash',
      from,
      to,
      countedAsAttempt: false,
      packageChars: 10,
      packageLevel: 1,
      packageCut: false,
      summary: 'model',
    };
    expect(validateEventPayload('session.handoff', 1, bare)).toEqual(bare);
  });

  it('session.handoff refuses a bad cause, summary, size, executor and an extra field', () => {
    const bad: Record<string, unknown>[] = [
      { ...handoff, cause: 'cosmic_rays' },
      { ...handoff, summary: 'magic' },
      { ...handoff, packageChars: -1 },
      { ...handoff, packageLevel: 1.5 },
      { ...handoff, packageCut: 'no' },
      { ...handoff, to: { client: 'codex' } },
      { ...handoff, summaryError: 'x'.repeat(513) },
      { ...handoff, extra: 1 },
    ];
    for (const payload of bad) {
      expect(() => validateEventPayload('session.handoff', 1, payload)).toThrow();
    }
    expect(() =>
      validateEventPayload('session.handoff', 1, { ...handoff, from: undefined }),
    ).toThrow();
  });

  it('lists the ways a package summary is made', () => {
    expect([...PACKAGE_SUMMARIES]).toEqual([
      'deterministic',
      'model',
      'model_failed',
      'model_unavailable',
    ]);
  });

  it('session.handoff_failed accepts the wait and the reason, with or without an error', () => {
    expect(validateEventPayload('session.handoff_failed', 1, failed)).toEqual(failed);
    const broken = {
      cause: 'stuck',
      from,
      reason: 'selection_failed',
      on: [],
      until: null,
      error: 'the selector failed',
    };
    expect(validateEventPayload('session.handoff_failed', 1, broken)).toEqual(broken);
  });

  it('session.handoff_failed refuses an empty reason, a negative end and extra fields', () => {
    const bad: Record<string, unknown>[] = [
      { ...failed, reason: '' },
      { ...failed, until: -1 },
      { ...failed, until: undefined },
      { ...failed, on: 'gpt@codex/personal' },
      { ...failed, cause: 'cosmic_rays' },
      { ...failed, from: { client: 'codex' } },
      { ...failed, error: 'x'.repeat(513) },
      { ...failed, extra: 1 },
    ];
    for (const payload of bad) {
      expect(() => validateEventPayload('session.handoff_failed', 1, payload)).toThrow();
    }
  });

  it('attempt.checkpoint_failed, attempt.aborted and session.processes_left are strict', () => {
    const checkpoint = {
      reason: 'interval',
      branch: 'play/p1/a1',
      error: 'git failed',
      ...correlation,
    };
    expect(validateEventPayload('attempt.checkpoint_failed', 1, checkpoint)).toEqual(checkpoint);
    expect(() =>
      validateEventPayload('attempt.checkpoint_failed', 1, { ...checkpoint, reason: 'whim' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('attempt.checkpoint_failed', 1, { ...checkpoint, extra: 1 }),
    ).toThrow();

    const aborted = { sessionId: 's1', error: 'the store failed', ...correlation };
    expect(validateEventPayload('attempt.aborted', 1, aborted)).toEqual(aborted);
    expect(() =>
      validateEventPayload('attempt.aborted', 1, { ...aborted, error: undefined }),
    ).toThrow();
    expect(() => validateEventPayload('attempt.aborted', 1, { ...aborted, extra: 1 })).toThrow();

    const left = { sessionId: 's1', pids: [4242, 4243], ...correlation };
    expect(validateEventPayload('session.processes_left', 1, left)).toEqual(left);
    expect(() =>
      validateEventPayload('session.processes_left', 1, { ...left, pids: [] }),
    ).toThrow();
    expect(() =>
      validateEventPayload('session.processes_left', 1, { ...left, extra: 1 }),
    ).toThrow();
  });
});
