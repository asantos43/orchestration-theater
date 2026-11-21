// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  buildTrajectory,
  isTrajectoryEvent,
  TERMINAL_OUTPUT_EVENT,
  type TrajectoryEvent,
} from './trajectory.js';

type Payload = Extract<TrajectoryEvent['payload'][string], Record<string, unknown>>;
let counter = 0;
function event(
  type: string,
  payload: TrajectoryEvent['payload'] = {},
  extra: { attemptId?: string; playId?: string; at?: number } = {},
): TrajectoryEvent {
  counter += 1;
  return {
    id: counter,
    type,
    timestamp: extra.at ?? counter * 10,
    payload,
    playId: extra.playId ?? 'p1',
    attemptId: extra.attemptId ?? 'p1/a/1',
  };
}

const update = (value: Payload, attemptId?: string): TrajectoryEvent =>
  event('session.update', { update: value }, attemptId === undefined ? {} : { attemptId });

describe('isTrajectoryEvent', () => {
  it('takes the session, attempt, permission, tool and terminal events and the demand moves', () => {
    for (const type of [
      'session.update',
      'attempt.submitted',
      'permission.asked',
      'tool.called',
      TERMINAL_OUTPUT_EVENT,
      'demand.transitioned',
    ]) {
      expect(isTrajectoryEvent(type), type).toBe(true);
    }
    for (const type of ['play.created', 'usage.recorded', 'workspace.integrated']) {
      expect(isTrajectoryEvent(type), type).toBe(false);
    }
  });
});

describe('buildTrajectory', () => {
  it('joins the chunks of a message and closes the turn at the end of the prompt', () => {
    const built = buildTrajectory('p1', [
      event('session.opened', {}),
      update({ kind: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } }),
      update({ kind: 'agent_message_chunk', content: { type: 'text', text: 'lo' } }),
      event('session.prompt_finished', { stopReason: 'end_turn' }),
      update({ kind: 'agent_thought_chunk', content: { type: 'text', text: 'again' } }),
      event('session.prompt_finished', { stopReason: 'end_turn' }),
      event('session.closed', { reason: 'done' }),
    ]);
    expect(built.attempts).toHaveLength(1);
    const [attempt] = built.attempts;
    expect(attempt?.state).toBe('closed');
    expect(attempt?.turns.map((turn) => turn.index)).toEqual([1, 2]);
    expect(attempt?.turns[0]?.entries).toMatchObject([{ kind: 'message', text: 'Hello' }]);
    expect(attempt?.turns[0]?.stopReason).toBe('end_turn');
    expect(attempt?.turns[1]?.entries).toMatchObject([{ kind: 'thought', text: 'again' }]);
    expect(attempt?.notices.map((notice) => notice.type)).toEqual([
      'session.opened',
      'session.closed',
    ]);
  });

  it('merges the updates of a tool call and pairs a tool call of the daemon with its end', () => {
    const built = buildTrajectory('p1', [
      update({
        kind: 'tool_call',
        toolCallId: 't1',
        title: 'Edit a.ts',
        toolKind: 'edit',
        status: 'pending',
        locations: [{ path: 'a.ts' }],
      }),
      update({ kind: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
      event('tool.called', { callId: 'c1', tool: 'run_command', summary: 'ls' }),
      event('tool.finished', { callId: 'c1', outcome: 'ok', exitCode: 0, durationMs: 12 }),
      event('tool.called', { callId: 'c2', tool: 'view_diff', summary: '' }),
    ]);
    const entries = built.attempts[0]?.turns[0]?.entries ?? [];
    expect(entries[0]).toMatchObject({ kind: 'tool_call', status: 'completed', paths: ['a.ts'] });
    expect(entries[1]).toMatchObject({ kind: 'tool', outcome: 'ok', exitCode: 0, durationMs: 12 });
    expect(entries[2]).toMatchObject({ kind: 'tool', callId: 'c2', outcome: undefined });
  });

  it('pairs a permission with its answer and keeps the output of a terminal', () => {
    const built = buildTrajectory('p1', [
      event('permission.asked', { tool: 'run_command', toolCallId: 't1', paths: ['a'] }),
      event('permission.answered', { tool: 'run_command', toolCallId: 't1', answer: 'allow' }),
      event(TERMINAL_OUTPUT_EVENT, { toolCallId: 't1', text: 'ok\n' }),
    ]);
    const entries = built.attempts[0]?.turns[0]?.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'permission', answer: 'allow', paths: ['a'] });
    expect(entries[1]).toMatchObject({ kind: 'terminal', text: 'ok\n' });
  });

  it('keeps the attempts apart, in order, and the moves of the demands', () => {
    const built = buildTrajectory('p1', [
      event('session.opened', { demandId: 'alpha' }, { attemptId: 'p1/alpha/1', at: 10 }),
      event('session.opened', { demandId: 'beta' }, { attemptId: 'p1/beta/1', at: 20 }),
      event('demand.transitioned', { demandId: 'alpha', from: 'ready', to: 'running' }),
      event('attempt.submitted', { branch: 'b' }, { attemptId: 'p1/alpha/1' }),
    ]);
    expect(
      built.attempts.map((attempt) => [attempt.attemptId, attempt.demandId, attempt.state]),
    ).toEqual([
      ['p1/alpha/1', 'alpha', 'ended'],
      ['p1/beta/1', 'beta', 'running'],
    ]);
    expect(built.transitions).toEqual([
      expect.objectContaining({ demandId: 'alpha', from: 'ready', to: 'running' }),
    ]);
    expect(built.attempts[0]?.notices[1]?.detail).toBe('branch=b');
  });

  it('skips the events of other plays, ignores what does not read, and folds twice the same', () => {
    const events: TrajectoryEvent[] = [
      event('session.opened', {}, { playId: 'other', attemptId: 'x/a/1' }),
      update({ kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
      update({ kind: 'nonsense' }),
      event('tool.called', {}),
      event('play.created', {}),
    ];
    const once = buildTrajectory('p1', events);
    expect(once.attempts).toHaveLength(1);
    expect(once.attempts[0]?.turns[0]?.entries).toHaveLength(1);
    expect(buildTrajectory('p1', events)).toEqual(once);
    expect(once.lastEventId).toBe(events[3]?.id);
  });
});
