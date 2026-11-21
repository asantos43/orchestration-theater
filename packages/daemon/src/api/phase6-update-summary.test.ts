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
      `updates ${reviewer} (reviewer): 8 (tool_call 3, tool_call_update 2, agent_message_chunk 1, agent_thought_chunk 1, plan 1) over 59.0s`,
      `tools ${reviewer}: bash 2, read 1`,
      `updates ${planner} (plan_reviewer?): 1 (agent_message_chunk 1) over 0.0s`,
      `last updates ${reviewer}: tool_call_update(bash, in_progress), tool_call(read, pending), tool_call(bash, pending), tool_call_update(bash, completed), plan`,
      'updates: no session of the Director in the log (the Director does not record session.update)',
    ]);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('keeps sessions of the same client apart: ids with the same start print whole', () => {
    nextId = 1;
    // OpenCode: `ses_<time><random>`, the first 12 characters repeat between sessions of one run.
    const openCode = ['ses_e04a1b2c3d4eAAAA1111', 'ses_e04a1b2c3d4eBBBB2222'];
    // Codex: UUIDv7, the start is the time; Claude Code: UUIDv4, the start is random.
    const codex = ['0197a1b2-c3d4-7e5f-8a9b-000000000001', '0197a1b2-c3d4-7e5f-8a9b-000000000002'];
    const claude = ['5f3c9a10-1111-4222-8333-444455556666', 'a81d77e2-1111-4222-8333-444455556666'];
    for (const ids of [openCode, codex, claude]) {
      const events = ids.map((sessionId, index) =>
        update(sessionId, 1000 + index, { kind: 'plan', entries: [] }, `att-${String(index)}`),
      );
      const lines = summarizeSessionUpdates(events);
      const printed = lines
        .filter((line) => line.startsWith('updates ') && line.includes(' ('))
        .map((line) => line.split(' ')[1]);
      expect(printed.sort()).toEqual([...ids].sort());
    }
  });

  it('says the Director is not in the log when no session is of the chat', () => {
    nextId = 1;
    const lines = summarizeSessionUpdates([
      update('sess-actor', 1000, { kind: 'plan', entries: [] }, 'att-1'),
    ]);
    expect(lines).toContain(
      'updates: no session of the Director in the log (the Director does not record session.update)',
    );
  });

  it('shows a session with no play and no attempt as chat, and then does not say it is missing', () => {
    nextId = 1;
    const lines = summarizeSessionUpdates([
      event('session.update', 1000, {
        sessionId: 'sess-chat',
        update: { kind: 'agent_message_chunk', content: { type: 'text', text: SECRET } },
      }),
    ]);
    expect(lines[0]).toBe('updates sess-chat (chat): 1 (agent_message_chunk 1) over 0.0s');
    expect(lines.join('\n')).not.toContain('no session of the Director');
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
