// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  summarizeSessionUpdates,
  toolNameOf,
  type SummarizableEvent,
} from './phase6-update-summary.js';

let nextId = 1;
function event(
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
  envelope: { playId?: string; attemptId?: string } = {},
): SummarizableEvent {
  return { id: nextId++, type, timestamp, payload, ...envelope };
}

const SECRET = 'SEGREDO-do-modelo';

const update = (sessionId: string, at: number, body: Record<string, unknown>, attemptId?: string) =>
  event(
    'session.update',
    at,
    {
      sessionId,
      update: body,
      playId: 'play-1',
      ...(attemptId === undefined ? {} : { attemptId }),
    },
    attemptId === undefined ? {} : { attemptId },
  );

describe('the diagnosis of the session updates (phase 6 real acceptance)', () => {
  it('names the tool by the first word of its title, never by arguments or paths', () => {
    expect(toolNameOf('bash', 'execute')).toBe('bash');
    expect(toolNameOf('Read: /home/x/file.ts', 'read')).toBe('Read');
    expect(toolNameOf('/usr/bin/cat file', 'read')).toBe('read');
    expect(toolNameOf('', 'edit')).toBe('edit');
    expect(toolNameOf(undefined, undefined)).toBe('?');
    expect(toolNameOf('x'.repeat(100), 'other')).toHaveLength(32);
  });

  it('is empty when the log has no session.update', () => {
    expect(summarizeSessionUpdates([event('play.transitioned', 1, { to: 'x' })])).toEqual([]);
    expect(summarizeSessionUpdates([])).toEqual([]);
  });

  it('counts kinds, tools and time per session, with the role of the attempt, and no content', () => {
    nextId = 1;
    const reviewer = 'sess-reviewer-0001';
    const planner = 'sess-planner-00002';
    const events: SummarizableEvent[] = [
      event('executor.selected', 1000, {
        role: 'plan_reviewer',
        playId: 'play-1',
        outcome: 'selected',
      }),
      event('session.opened', 1100, { sessionId: reviewer, playId: 'play-1', attemptId: 'att-2' }),
      update(
        reviewer,
        2000,
        { kind: 'agent_message_chunk', content: { type: 'text', text: SECRET } },
        'att-2',
      ),
      update(
        reviewer,
        3000,
        { kind: 'agent_thought_chunk', content: { type: 'text', text: SECRET } },
        'att-2',
      ),
      update(
        reviewer,
        4000,
        {
          kind: 'tool_call',
          toolCallId: 'c1',
          title: 'bash',
          toolKind: 'execute',
          status: 'pending',
        },
        'att-2',
      ),
      update(
        reviewer,
        5000,
        { kind: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
        'att-2',
      ),
      update(
        reviewer,
        6000,
        {
          kind: 'tool_call',
          toolCallId: 'c2',
          title: `read ${SECRET}`,
          toolKind: 'read',
          status: 'pending',
        },
        'att-2',
      ),
      update(
        reviewer,
        7000,
        {
          kind: 'tool_call',
          toolCallId: 'c3',
          title: 'bash',
          toolKind: 'execute',
          status: 'pending',
        },
        'att-2',
      ),
      update(
        reviewer,
        8000,
        { kind: 'tool_call_update', toolCallId: 'c3', status: 'completed' },
        'att-2',
      ),
      update(
        reviewer,
        61_000,
        { kind: 'plan', entries: [{ content: SECRET, priority: 'high', status: 'pending' }] },
        'att-2',
      ),
      event(
        'attempt.submit_failed',
        62_000,
        { tool: 'submitPlanReview', role: 'reviewer', attemptId: 'att-2' },
        { attemptId: 'att-2' },
      ),
      event('session.opened', 63_000, { sessionId: planner, playId: 'play-1', attemptId: 'att-1' }),
      update(
        planner,
        64_000,
        { kind: 'agent_message_chunk', content: { type: 'text', text: SECRET } },
        'att-1',
      ),
    ];
    const lines = summarizeSessionUpdates(events);
    expect(lines).toEqual([
      `updates ${reviewer.slice(0, 8)} (reviewer): 8 (tool_call 3, tool_call_update 2, agent_message_chunk 1, agent_thought_chunk 1, plan 1) over 59.0s`,
      `tools ${reviewer.slice(0, 8)}: bash 2, read 1`,
      `updates ${planner.slice(0, 8)} (plan_reviewer?): 1 (agent_message_chunk 1) over 0.0s`,
      `last updates ${reviewer.slice(0, 8)}: tool_call_update(bash, in_progress), tool_call(read, pending), tool_call(bash, pending), tool_call_update(bash, completed), plan`,
    ]);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
