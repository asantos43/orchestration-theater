// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DAEMON_NOTICE_KINDS,
  RECOVERY_NOTICE_KINDS,
  SCENARIO_NOTICE_KINDS,
} from './notice-events.js';
import { PLAY_NOTICE_KINDS } from './scenario-events.js';
import { validateEventPayload } from './events.js';

/** The events of the step P24 (N146 and N149): the situations the daemon only logged. [proposta] */
describe('the notice events of P24', () => {
  it('quota.probe_failed: accepts each reason and refuses the strange', () => {
    const failed = {
      profile: 'minimax/key',
      reason: 'rate_limited',
      status: 429,
      backoffMs: 60_000,
      detail: 'MiniMax answered 429',
    };
    expect(validateEventPayload('quota.probe_failed', 1, failed)).toEqual(failed);
    const bare = { profile: 'minimax/key', reason: 'no_key' };
    expect(validateEventPayload('quota.probe_failed', 1, bare)).toEqual(bare);
    expect(() =>
      validateEventPayload('quota.probe_failed', 1, { ...failed, reason: 'x' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.probe_failed', 1, { ...failed, detail: 'x'.repeat(513) }),
    ).toThrow();
    expect(() => validateEventPayload('quota.probe_failed', 1, { ...failed, key: 's' })).toThrow();
    expect(() => validateEventPayload('quota.probe_failed', 1, { reason: 'no_key' })).toThrow();
  });

  it('quota.signal_dropped: the profile and the session may be unknown', () => {
    const dropped = {
      profile: null,
      sessionId: 'S1',
      reason: 'no_profile',
    };
    expect(validateEventPayload('quota.signal_dropped', 1, dropped)).toEqual(dropped);
    const known = { profile: 'a/b', sessionId: null, reason: 'bad_reading', detail: 'x' };
    expect(validateEventPayload('quota.signal_dropped', 1, known)).toEqual(known);
    expect(() =>
      validateEventPayload('quota.signal_dropped', 1, { ...dropped, reason: 'mood' }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.signal_dropped', 1, { ...dropped, extra: true }),
    ).toThrow();
    expect(() =>
      validateEventPayload('quota.signal_dropped', 1, { reason: 'no_profile' }),
    ).toThrow();
  });

  it('usage.notice: a kind, what the situation knows and a short detail', () => {
    const notice = { kind: 'bad_cost', sessionId: 'S1', profile: null };
    expect(validateEventPayload('usage.notice', 1, notice)).toEqual(notice);
    const full = { ...notice, kind: 'cap_question_failed', profile: 'a/b', detail: 'x' };
    for (const kind of [
      'ccusage_unavailable',
      'ccusage_wrong_version',
      'ccusage_failed',
      'ccusage_divergence',
    ]) {
      expect(validateEventPayload('usage.notice', 1, { ...full, kind })).toEqual({ ...full, kind });
    }
    expect(validateEventPayload('usage.notice', 1, full)).toEqual(full);
    expect(() => validateEventPayload('usage.notice', 1, { ...notice, kind: 'x' })).toThrow();
    expect(() =>
      validateEventPayload('usage.notice', 1, { ...notice, detail: 'x'.repeat(513) }),
    ).toThrow();
    expect(() => validateEventPayload('usage.notice', 1, { ...notice, extra: 1 })).toThrow();
  });

  it('profile.warning: the profile, a kind and no secret field', () => {
    const warning = { profileId: 'codex/work', kind: 'logout_failed', detail: 'exit 1' };
    expect(validateEventPayload('profile.warning', 1, warning)).toEqual(warning);
    expect(
      validateEventPayload('profile.warning', 1, { profileId: 'a/b', kind: 'secret_missing' }),
    ).toEqual({ profileId: 'a/b', kind: 'secret_missing' });
    expect(() => validateEventPayload('profile.warning', 1, { ...warning, kind: 'x' })).toThrow();
    expect(() => validateEventPayload('profile.warning', 1, { ...warning, apiKey: 's' })).toThrow();
  });

  it('executor.changed: registered or removed, with the roles', () => {
    const changed = {
      executorId: 'claude-opus-high@claude-code/work',
      change: 'registered',
      profile: 'claude-code/work',
      roles: ['implementer'],
    };
    expect(validateEventPayload('executor.changed', 1, changed)).toEqual(changed);
    const removed = { ...changed, change: 'removed', profile: null, roles: [] };
    expect(validateEventPayload('executor.changed', 1, removed)).toEqual(removed);
    expect(() =>
      validateEventPayload('executor.changed', 1, { ...changed, change: 'x' }),
    ).toThrow();
    expect(() => validateEventPayload('executor.changed', 1, { ...changed, extra: 1 })).toThrow();
  });

  it('daemon.notice: protection_reduced is a kind (N334, [proposta])', () => {
    expect(DAEMON_NOTICE_KINDS).toContain('protection_reduced');
    const notice = { kind: 'protection_reduced', subject: 'warn', detail: 'no layer 3' };
    expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
  });

  it('daemon.notice: accepts every kind, with a null subject and detail', () => {
    for (const kind of DAEMON_NOTICE_KINDS) {
      const notice = { kind, subject: null, detail: null };
      expect(validateEventPayload('daemon.notice', 1, notice)).toEqual(notice);
    }
    const client = { kind: 'client_not_found', subject: 'codex', detail: 'not in PATH' };
    expect(validateEventPayload('daemon.notice', 1, client)).toEqual(client);
    expect(() =>
      validateEventPayload('daemon.notice', 1, { kind: 'x', subject: null, detail: null }),
    ).toThrow();
    expect(() =>
      validateEventPayload('daemon.notice', 1, { ...client, detail: 'x'.repeat(513) }),
    ).toThrow();
    expect(() => validateEventPayload('daemon.notice', 1, { ...client, extra: 1 })).toThrow();
  });

  it('recovery.notice: accepts every kind', () => {
    for (const kind of RECOVERY_NOTICE_KINDS) {
      const notice = { kind, subject: 'x', detail: 'y' };
      expect(validateEventPayload('recovery.notice', 1, notice)).toEqual(notice);
    }
    expect(() =>
      validateEventPayload('recovery.notice', 1, { kind: 'x', subject: null, detail: null }),
    ).toThrow();
    expect(() =>
      validateEventPayload('recovery.notice', 1, { kind: 'process_not_tracked' }),
    ).toThrow();
  });

  it('scenario.notice: accepts every kind and needs the scenario', () => {
    for (const kind of SCENARIO_NOTICE_KINDS) {
      const notice = { scenarioId: 'S1', kind, subject: null, detail: 'y' };
      expect(validateEventPayload('scenario.notice', 1, notice)).toEqual(notice);
    }
    expect(() =>
      validateEventPayload('scenario.notice', 1, {
        kind: 'idea_not_returned',
        subject: null,
        detail: null,
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload('scenario.notice', 1, {
        scenarioId: 'S1',
        kind: 'x',
        subject: null,
        detail: null,
      }),
    ).toThrow();
  });

  it('play.notice: has the kinds of the pipeline and the one of the exhaustion rules (P19)', () => {
    for (const kind of [
      'exhaustion_not_read',
      'play_not_resumed',
      'effect_not_started',
      'finish_not_handled',
      'deadline_not_delivered',
    ]) {
      expect(PLAY_NOTICE_KINDS).toContain(kind);
      const notice = { scenarioId: null, playId: 'P1', kind, detail: 'x' };
      expect(validateEventPayload('play.notice', 1, notice)).toEqual(notice);
    }
  });
});
