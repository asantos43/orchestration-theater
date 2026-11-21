// SPDX-License-Identifier: MPL-2.0
import type { ApiDemandDiff, TrajectoryEvent } from '@otheater/protocol';

/**
 * The events of a play of the `fake-agent` as the log keeps them (the shapes the real run writes,
 * see `packages/daemon/src/trajectory/trajectory-e2e.test.ts`), for the tests of the tab: nothing
 * real runs here (N57).
 */

export function trajectoryEvent(
  id: number,
  type: string,
  payload: TrajectoryEvent['payload'],
  attemptId = 'P1/a/1',
  playId = 'P1',
): TrajectoryEvent {
  return { id, type, timestamp: 1_000 + id * 100, payload, playId, attemptId };
}

const message = (id: number, text: string, attemptId?: string): TrajectoryEvent =>
  trajectoryEvent(
    id,
    'session.update',
    { update: { kind: 'agent_message_chunk', content: { type: 'text', text } } },
    attemptId,
  );

/** One attempt on the demand `D1`, two turns: the first calls a tool, the second says it is done. */
export function fakePlayEvents(): TrajectoryEvent[] {
  return [
    trajectoryEvent(1, 'session.opened', { demandId: 'D1' }),
    message(2, 'Writing the file'),
    trajectoryEvent(3, 'session.update', {
      update: {
        kind: 'tool_call',
        toolCallId: 't1',
        title: 'Write notes.txt',
        toolKind: 'edit',
        status: 'pending',
        locations: [{ path: 'notes.txt' }],
      },
    }),
    trajectoryEvent(4, 'session.update', {
      update: { kind: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    }),
    trajectoryEvent(5, 'permission.asked', { tool: 'run_command', toolCallId: 't2', paths: [] }),
    trajectoryEvent(6, 'permission.answered', {
      tool: 'run_command',
      toolCallId: 't2',
      answer: 'allow',
    }),
    trajectoryEvent(7, 'session.prompt_finished', { stopReason: 'end_turn' }),
    message(8, 'All done'),
    trajectoryEvent(9, 'session.prompt_finished', { stopReason: 'end_turn' }),
    trajectoryEvent(10, 'session.closed', { reason: 'done' }),
    trajectoryEvent(11, 'attempt.submitted', { demandId: 'D1', branch: 'otheater/P1/a1' }),
    trajectoryEvent(12, 'demand.transitioned', {
      demandId: 'D1',
      from: 'running',
      to: 'integrated',
    }),
  ];
}

export const DEMAND_DIFF: ApiDemandDiff = {
  playId: 'P1',
  demandId: 'D1',
  attemptId: 'P1/a/1',
  available: true,
  unavailable: null,
  diff: [
    'diff --git a/notes.txt b/notes.txt',
    '--- /dev/null',
    '+++ b/notes.txt',
    '@@ -0,0 +1 @@',
    '+written by the fake Actor',
  ].join('\n'),
  truncated: false,
};
