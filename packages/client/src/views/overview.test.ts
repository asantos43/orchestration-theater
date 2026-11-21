// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ActorActivity } from '../stores/activity.js';
import {
  demand,
  event,
  play,
  playTransitioned,
  demandTransitioned,
} from '../stores/fixtures.test-support.js';
import { actorRows, demandRows, eventRows, formatRemaining, pipelineView } from './overview.js';

const EXECUTOR = { client: 'claude', profile: 'main', model: 'sonnet' };

function actor(key: string, extra: Partial<ActorActivity> = {}): ActorActivity {
  return {
    key,
    sessionId: `s-${key}`,
    attemptId: key,
    playId: 'P1',
    demandId: 'D1',
    executor: EXECUTOR,
    startedAt: 1_000_000,
    paused: undefined,
    ...extra,
  };
}

describe('the pipeline', () => {
  it('marks the states before the current one as done and the others as to do', () => {
    const view = pipelineView(play('P1', 'S1', { state: 'EXECUTING' }), false);
    expect(view.steps.map((step) => `${step.state}:${step.mark}`)).toEqual([
      'NEED:done',
      'PLANNING:done',
      'REVIEWING_PLAN:done',
      'SCRIPTING:done',
      'REVIEWING_SCRIPT:done',
      'EXECUTING:current',
      'INTEGRATING:todo',
      'CRITIQUING:todo',
      'DECIDING:todo',
      'DELIVERING:todo',
      'DONE:todo',
    ]);
    expect(view).toMatchObject({ current: 'EXECUTING', paused: false, finished: false });
  });

  it('shows a side state only while the play is in it, at its place', () => {
    const clarifying = pipelineView(play('P1', 'S1', { state: 'CLARIFYING' }), false);
    expect(clarifying.steps.map((step) => step.state).slice(0, 4)).toEqual([
      'NEED',
      'PLANNING',
      'CLARIFYING',
      'REVIEWING_PLAN',
    ]);
    expect(clarifying.steps.find((step) => step.mark === 'current')?.state).toBe('CLARIFYING');
    const awaiting = pipelineView(play('P1', 'S1', { state: 'AWAITING_PRODUCER' }), false);
    expect(awaiting.steps.map((step) => step.state)).toContain('AWAITING_PRODUCER');
    expect(
      pipelineView(play('P1', 'S1', { state: 'EXECUTING' }), false).steps.map((s) => s.state),
    ).not.toContain('CLARIFYING');
  });

  it('marks a finished and a cancelled play', () => {
    const done = pipelineView(play('P1', 'S1', { state: 'DONE', finishedAt: 5 }), false);
    expect(done.finished).toBe(true);
    expect(done.steps.every((step) => step.mark !== 'todo')).toBe(true);
    const cancelled = pipelineView(play('P1', 'S1', { state: 'CANCELLED', finishedAt: 5 }), false);
    expect(cancelled.steps.filter((step) => step.mark === 'done')).toEqual([]);
    expect(cancelled.steps.at(-1)).toEqual({ state: 'CANCELLED', mark: 'current' });
  });

  it('carries the pause', () => {
    expect(pipelineView(play('P1', 'S1', { state: 'EXECUTING' }), true).paused).toBe(true);
  });
});

describe('the demand rows', () => {
  it('lists the demands with their dependencies and what still blocks them', () => {
    const d1 = { ...demand('P1', 'D1', 'approved'), createdAt: 1 };
    const d2 = { ...demand('P1', 'D2', 'running'), createdAt: 2 };
    const d3 = { ...demand('P1', 'D3', 'pending'), createdAt: 3 };
    const d4 = { ...demand('P1', 'D4', 'pending'), createdAt: 4, dependsOn: ['D2', 'D3', 'D1'] };
    const rows = demandRows('P1', [d4, d2, d1, d3], {
      'P1/D3': { demandId: 'D3' } as never,
    });
    expect(rows.map((row) => row.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    expect(rows[3]).toMatchObject({
      dependsOn: ['D2', 'D3', 'D1'],
      pendingDeps: ['D2', 'D3'],
      waiting: false,
    });
    expect(rows[2]?.waiting).toBe(true);
    expect(rows[0]?.pendingDeps).toEqual([]);
  });
});

describe('the Actor rows', () => {
  const demands = { P1: [{ ...demand('P1', 'D1'), timeoutMin: 10 }] };

  it('works out the time left from the timeout of the demand', () => {
    const rows = actorRows({ a: actor('a') }, demands, new Set(['P1']), 1_000_000 + 4 * 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profile: 'main',
      client: 'claude',
      model: 'sonnet',
      remainingMs: 6 * 60_000,
    });
  });

  it('goes negative when the estimate ran out and is unknown without the demand', () => {
    const late = actorRows({ a: actor('a') }, demands, new Set(['P1']), 1_000_000 + 11 * 60_000);
    expect(late[0]?.remainingMs).toBe(-60_000);
    const unknown = actorRows({ a: actor('a', { demandId: 'D9' }) }, demands, new Set(['P1']), 0);
    expect(unknown[0]?.remainingMs).toBeUndefined();
  });

  it('keeps only the Actors of the plays of the scenario, oldest first', () => {
    const rows = actorRows(
      {
        b: actor('b', { startedAt: 20 }),
        a: actor('a', { startedAt: 10 }),
        x: actor('x', { playId: 'P2' }),
        n: actor('n', { playId: undefined }),
      },
      demands,
      new Set(['P1']),
      0,
    );
    expect(rows.map((row) => row.key)).toEqual(['a', 'b']);
  });
});

describe('the event rows', () => {
  const events = [
    event(1, 'play.created', {}, { scenarioId: 'S1', playId: 'P1' }),
    event(2, 'session.update', {}, { playId: 'P1' }),
    playTransitioned(3, 'S1', 'P1', 'PLANNING'),
    event(4, 'play.created', {}, { scenarioId: 'S2', playId: 'P9' }),
    demandTransitioned(5, 'S1', 'P1', 'D1', 'pending', 'ready'),
    event(6, 'session.opened', {}, { playId: 'P1' }),
  ];
  const scenario = { id: 'S1', playIds: new Set(['P1']) };

  it('lists the newest first, of the scenario only, and leaves out the hidden types', () => {
    const rows = eventRows(events, scenario, ['session.update'], 10);
    expect(rows.map((row) => row.id)).toEqual([6, 5, 3, 1]);
    expect(rows[1]?.detail).toBe('D1 → ready');
    expect(rows[2]?.detail).toBe('NEED → PLANNING');
    expect(rows[0]?.detail).toBeUndefined();
  });

  it('stops at the limit and lets a hidden list of nothing show everything', () => {
    expect(eventRows(events, scenario, [], 2).map((row) => row.id)).toEqual([6, 5]);
    expect(eventRows(events, scenario, [], 10).map((row) => row.id)).toContain(2);
  });
});

describe('formatRemaining', () => {
  it('writes seconds, minutes, hours and the sign', () => {
    expect(formatRemaining(45_000)).toBe('45s');
    expect(formatRemaining(6 * 60_000 + 5_000)).toBe('6m05s');
    expect(formatRemaining(3_720_000)).toBe('1h02m');
    expect(formatRemaining(-60_000)).toBe('-1m00s');
    expect(formatRemaining(0)).toBe('0s');
  });
});
