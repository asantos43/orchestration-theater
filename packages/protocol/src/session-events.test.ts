// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  INTERRUPTION_CAUSE_NAMES,
  parseNewEvent,
  RESUME_FORM_NAMES,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent, DAEMON_EVENT_TYPES, validateEventPayload } from './events.js';
import { INTERRUPTION_CAUSES, RESUME_FORMS, CHECKPOINT_REASONS } from './session-events.js';

const executor = { client: 'claude-code', profile: 'empresa', model: 'opus', effort: 'high' };
const correlation = { playId: 'p1', demandId: 'd1', attemptId: 'a1' };

const good: Record<string, unknown> = {
  'session.opened': {
    sessionId: 's1',
    executor,
    via: 'acp',
    cwd: '/work/p1',
    canLoad: true,
    ...correlation,
  },
  'session.update': {
    sessionId: 's1',
    update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    ...correlation,
  },
  'session.prompt_finished': { sessionId: 's1', stopReason: 'end_turn', durationMs: 1200 },
  'session.interrupted': {
    sessionId: 's1',
    cause: 'quota_exhausted',
    resetsAt: 1_700_000_000_000,
    checkpointSha: 'abc123',
    form: 'handoff',
    from: executor,
    to: { client: 'codex', profile: 'conta-1', model: 'gpt' },
    ...correlation,
  },
  'session.resumed': {
    sessionId: 's2',
    previousSessionId: 's1',
    form: 'handoff',
    from: executor,
    to: { client: 'codex', profile: 'conta-1', model: 'gpt' },
    cause: 'quota_exhausted',
    ...correlation,
  },
  'session.cancel_escalated': {
    sessionId: 's1',
    mode: 'escalate',
    pid: 4242,
    siblings: 2,
    ...correlation,
  },
  'session.turn_timeout': {
    sessionId: 's1',
    limitMs: 900_000,
    elapsedMs: 900_001,
    action: 'cancel',
    ...correlation,
  },
  'session.closed': { sessionId: 's1', reason: 'completed' },
  'attempt.checkpoint': {
    sha: 'abc123',
    label: 'edit batch 3',
    reason: 'edit_batch',
    branch: 'play/p1/attempts/d1/1',
    ...correlation,
  },
  'attempt.submitted': {
    tool: 'submit_plan',
    role: 'planner',
    output: { steps: ['a'] },
    calls: 2,
    ...correlation,
  },
  'attempt.submit_failed': {
    tool: 'submit_plan',
    role: 'planner',
    errors: 'steps: required',
    calls: 3,
    ...correlation,
  },
};

describe('session and checkpoint events', () => {
  it('are registered at schemaVersion 1', () => {
    for (const type of Object.keys(good)) {
      expect(DAEMON_EVENT_TYPES[type as keyof typeof DAEMON_EVENT_TYPES].schemaVersion, type).toBe(
        1,
      );
    }
  });

  it('accept a good payload and build an event the EventLog accepts', () => {
    for (const [type, payload] of Object.entries(good)) {
      expect(validateEventPayload(type, 1, payload), type).toEqual(payload);
      const event = buildDaemonEvent(type as keyof typeof DAEMON_EVENT_TYPES, payload as never);
      expect(parseNewEvent(event), type).toEqual(event);
    }
  });

  it('correlation is optional on every payload', () => {
    expect(
      validateEventPayload('session.closed', 1, { sessionId: 's1', reason: 'failed' }),
    ).toEqual({
      sessionId: 's1',
      reason: 'failed',
    });
  });

  it('are strict', () => {
    for (const [type, payload] of Object.entries(good)) {
      expect(
        () => validateEventPayload(type, 1, { ...(payload as object), extra: 1 }),
        type,
      ).toThrow(InvalidInput);
    }
  });

  it('refuse bad payloads', () => {
    const bad: [string, unknown][] = [
      ['session.opened', { ...(good['session.opened'] as object), canLoad: 'yes' }],
      ['session.opened', { sessionId: 's1', via: 'acp', canLoad: true }],
      ['session.update', { sessionId: 's1', update: { kind: 'nope' } }],
      ['session.prompt_finished', { sessionId: 's1', stopReason: 'stop' }],
      ['session.interrupted', { sessionId: 's1', cause: 'cosmic_rays' }],
      ['session.interrupted', { sessionId: 's1', cause: 'stuck', form: 'restart' }],
      ['session.interrupted', { sessionId: 's1', cause: 'stuck', to: { client: 'codex' } }],
      ['session.resumed', { ...(good['session.resumed'] as object), form: 'restart' }],
      [
        'session.cancel_escalated',
        { ...(good['session.cancel_escalated'] as object), mode: 'release' },
      ],
      [
        'session.cancel_escalated',
        { ...(good['session.cancel_escalated'] as object), siblings: -1 },
      ],
      ['session.turn_timeout', { ...(good['session.turn_timeout'] as object), action: 'off' }],
      ['session.turn_timeout', { ...(good['session.turn_timeout'] as object), limitMs: 0 }],
      ['session.closed', { sessionId: 's1', reason: 'because' }],
      ['attempt.checkpoint', { sha: 'a', label: 'x', reason: 'whim' }],
      ['attempt.checkpoint', { sha: '', label: 'x', reason: 'interval' }],
      ['attempt.submitted', { tool: 'submit', role: 'planner', output: {}, calls: 0 }],
      ['attempt.submit_failed', { tool: 'submit', role: 'planner', errors: '', calls: 1 }],
      ['session.opened', { ...(good['session.opened'] as object), playId: '' }],
    ];
    for (const [type, payload] of bad) {
      expect(() => validateEventPayload(type, 1, payload), type).toThrow(InvalidInput);
    }
  });

  it('list the causes of the table in 5.16', () => {
    expect([...INTERRUPTION_CAUSES]).toEqual([
      'quota_exhausted',
      'spend_cap',
      'transient',
      'client_crash',
      'daemon_restart',
      'timeout',
      'stuck',
      'refusal',
      'permission',
      'profile_removed',
    ]);
    expect([...RESUME_FORMS]).toEqual(['native', 'handoff']);
    expect([...CHECKPOINT_REASONS]).toEqual(['edit_batch', 'interval', 'interruption']);
  });
});

describe('the interruption vocabulary of the store', () => {
  it('matches the wire vocabulary of the events', () => {
    expect([...INTERRUPTION_CAUSE_NAMES]).toEqual([...INTERRUPTION_CAUSES]);
    expect([...RESUME_FORM_NAMES]).toEqual([...RESUME_FORMS]);
  });
});
