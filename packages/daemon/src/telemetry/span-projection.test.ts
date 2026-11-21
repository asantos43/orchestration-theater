// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the tests look up what they just built */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, JsonValue, TelemetrySpan } from '@otheater/core';
import { GEN_AI, OT, SPAN_NAME, WAIT_KIND } from './span-conventions.js';
import {
  attemptSpanId,
  playSpanId,
  sessionSpanId,
  traceIdForAttempt,
  traceIdForPlay,
} from './span-ids.js';
import { SpanProjection, directWaitSpan } from './span-projection.js';

const T0 = 1_800_000_000_000;

/** A synthetic log: ids grow by one and the time by `step` ms at each event. */
class Log {
  #id = 0;
  #ts = T0;
  readonly events: EventEnvelope[] = [];

  add(
    type: string,
    payload: Record<string, JsonValue>,
    ids: { playId?: string; attemptId?: string; scenarioId?: string } = {},
    step = 10,
  ): EventEnvelope {
    this.#id += 1;
    this.#ts += step;
    const event: EventEnvelope = {
      id: this.#id,
      timestamp: this.#ts,
      type,
      payload,
      ...ids,
    } as EventEnvelope;
    this.events.push(event);
    return event;
  }
}

function project(events: readonly EventEnvelope[]): TelemetrySpan[] {
  const projection = new SpanProjection();
  return events.flatMap((event) => projection.apply(event));
}

const EXECUTOR = { client: 'claude-code', profile: 'main', model: 'sonnet' };
const PLAY = { playId: 'p1', scenarioId: 's1' };
const ATTEMPT = { ...PLAY, attemptId: 'p1/alpha/1' };

function ms(value: bigint): number {
  return Number(value / 1_000_000n);
}

function byName(spans: readonly TelemetrySpan[], name: string): TelemetrySpan[] {
  return spans.filter((span) => span.name === name);
}

/** One whole play: NEED, EXECUTING with an attempt (session, a tool call), then DONE. */
function wholePlay(): Log {
  const log = new Log();
  log.add('play.created', { flowId: 'play' }, PLAY);
  log.add('play.transitioned', { event: 'START', from: 'NEED', to: 'EXECUTING' }, PLAY);
  log.add(
    'executor.selected',
    { outcome: 'selected', role: 'actor', executor: EXECUTOR },
    { ...PLAY },
  );
  log.add('session.opened', { sessionId: 'sess-1', via: 'new', executor: EXECUTOR }, ATTEMPT);
  log.add(
    'tool.called',
    { callId: 'c1', tool: 'submit', role: 'actor', summary: 'secret text', heavy: false },
    ATTEMPT,
  );
  log.add('tool.finished', { callId: 'c1', outcome: 'ok', durationMs: 5, queuedMs: 0 }, ATTEMPT);
  log.add('attempt.submitted', {}, ATTEMPT);
  log.add('session.prompt_finished', { sessionId: 'sess-1', stopReason: 'end_turn' }, ATTEMPT);
  log.add('session.closed', { sessionId: 'sess-1', reason: 'completed' }, ATTEMPT);
  log.add('play.transitioned', { event: 'DONE', from: 'EXECUTING', to: 'DONE' }, PLAY);
  return log;
}

describe('the tree of spans a play leaves (P4)', () => {
  it('has the play, its stages, the attempt, the session and the call, each under its parent', () => {
    const spans = project(wholePlay().events);
    const play = byName(spans, SPAN_NAME.play)[0]!;
    const stages = byName(spans, SPAN_NAME.stage);
    const agents = spans.filter((span) => span.name.startsWith('invoke_agent'));
    const tool = spans.find((span) => span.name.startsWith('execute_tool'))!;
    expect(play.parentSpanId).toBeNull();
    expect(play.spanId).toBe(playSpanId('p1'));
    expect(play.attributes[OT.playFinalState]).toBe('DONE');
    expect(stages.map((stage) => stage.attributes[OT.stage])).toEqual(['NEED', 'EXECUTING']);
    for (const stage of stages) expect(stage.parentSpanId).toBe(play.spanId);
    const attempt = agents.find((span) => span.attributes[OT.sessionId] === undefined)!;
    const session = agents.find((span) => span.attributes[OT.sessionId] === 'sess-1')!;
    expect(attempt.spanId).toBe(attemptSpanId('p1/alpha/1'));
    expect(attempt.parentSpanId).toBe(stages[1]?.spanId);
    expect(session.spanId).toBe(sessionSpanId('sess-1'));
    expect(session.parentSpanId).toBe(attempt.spanId);
    expect(tool.parentSpanId).toBe(session.spanId);
    expect(tool.name).toBe(SPAN_NAME.executeTool('submit'));
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceIdForPlay('p1')]));
  });

  it('keeps every child inside its parent in time, and ends the attempt with its last session', () => {
    const log = wholePlay();
    const spans = project(log.events);
    const byId = new Map(spans.map((span) => [span.spanId, span]));
    for (const span of spans) {
      expect(span.endTimeUnixNano).toBeGreaterThanOrEqual(span.startTimeUnixNano);
      const parent = span.parentSpanId === null ? undefined : byId.get(span.parentSpanId);
      if (parent === undefined) continue;
      expect(span.startTimeUnixNano).toBeGreaterThanOrEqual(parent.startTimeUnixNano);
      expect(span.endTimeUnixNano).toBeLessThanOrEqual(parent.endTimeUnixNano);
    }
    const attempt = byId.get(attemptSpanId('p1/alpha/1'))!;
    const session = byId.get(sessionSpanId('sess-1'))!;
    // `attempt.submitted` came before `session.closed`: the attempt ends where the session does.
    expect(ms(attempt.endTimeUnixNano)).toBe(ms(session.endTimeUnixNano));
    expect(attempt.attributes[OT.attemptEnd]).toBe('submitted');
    expect(attempt.status).toBe('ok');
    expect(session.attributes[OT.sessionCloseReason]).toBe('completed');
    expect(session.attributes[OT.sessionTurns]).toBe(1);
    expect(session.attributes[OT.closedBy]).toBeUndefined();
  });

  it('carries the correlation ids and the GenAI attributes, and never the text of a call', () => {
    const spans = project(wholePlay().events);
    const session = spans.find(
      (span) => span.attributes[OT.sessionId] === 'sess-1' && span.name.startsWith('invoke_agent'),
    )!;
    expect(session.name).toBe(SPAN_NAME.invokeAgent('actor'));
    expect(session.attributes).toMatchObject({
      [OT.playId]: 'p1',
      [OT.attemptId]: 'p1/alpha/1',
      [OT.sessionId]: 'sess-1',
      [OT.profile]: 'main',
      [OT.client]: 'claude-code',
      [OT.role]: 'actor',
      [GEN_AI.operationName]: 'invoke_agent',
      [GEN_AI.requestModel]: 'sonnet',
    });
    const stage = byName(spans, SPAN_NAME.stage)[1]!;
    expect(stage.attributes[OT.stageId]).toBe(stage.spanId);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('secret text');
  });

  it('gives the same spans when the same log is read again, from anywhere it was read before', () => {
    const { events } = wholePlay();
    const first = project(events);
    const again = project(events);
    expect(again).toEqual(first);
    expect(new Set(first.map((span) => `${span.traceId}/${span.spanId}`)).size).toBe(first.length);
  });

  it('closes what the play leaves open with the time of its end, and says why', () => {
    const log = new Log();
    log.add('play.created', { flowId: 'play' }, PLAY);
    log.add('play.transitioned', { event: 'START', from: 'NEED', to: 'EXECUTING' }, PLAY);
    log.add('session.opened', { sessionId: 'sess-9', executor: EXECUTOR }, ATTEMPT);
    log.add('tool.called', { callId: 'c9', tool: 'run', role: 'actor' }, ATTEMPT);
    const end = log.add(
      'play.transitioned',
      { event: 'CANCEL', from: 'EXECUTING', to: 'CANCELLED' },
      PLAY,
    );
    const spans = project(log.events);
    const open = spans.filter(
      (span) => span.name !== SPAN_NAME.play && span.name !== SPAN_NAME.stage,
    );
    expect(open.length).toBe(3);
    for (const span of open) {
      expect(span.attributes[OT.closedBy]).toBe('play_end');
      expect(ms(span.endTimeUnixNano)).toBe(end.timestamp);
    }
  });

  it('reads the roles from the selection of the play, one session at a time', () => {
    const log = new Log();
    log.add('play.created', { flowId: 'play' }, PLAY);
    log.add('executor.selected', { outcome: 'selected', role: 'author', executor: EXECUTOR }, PLAY);
    log.add(
      'session.opened',
      { sessionId: 'a', executor: EXECUTOR },
      { ...PLAY, attemptId: 'x/1' },
    );
    log.add('attempt.submitted', {}, { ...PLAY, attemptId: 'x/1' });
    log.add(
      'session.closed',
      { sessionId: 'a', reason: 'completed' },
      { ...PLAY, attemptId: 'x/1' },
    );
    log.add('executor.selected', { outcome: 'selected', role: 'critic', executor: EXECUTOR }, PLAY);
    log.add(
      'session.opened',
      { sessionId: 'b', executor: EXECUTOR },
      { ...PLAY, attemptId: 'y/1' },
    );
    log.add('attempt.submitted', {}, { ...PLAY, attemptId: 'y/1' });
    log.add(
      'session.closed',
      { sessionId: 'b', reason: 'completed' },
      { ...PLAY, attemptId: 'y/1' },
    );
    const spans = project(log.events);
    const roles = spans
      .filter(
        (span) => span.attributes[OT.sessionId] !== undefined && span.name.startsWith('invoke'),
      )
      .map((span) => span.attributes[OT.role]);
    expect(roles).toEqual(['author', 'critic']);
  });
});

describe('the traces (P4)', () => {
  it('puts an attempt in the trace of its play and an attempt with no play in one of its own', () => {
    expect(traceIdForAttempt({ playId: 'p1', attemptId: 'a' })).toBe(traceIdForPlay('p1'));
    const director = traceIdForAttempt({ attemptId: 'director/s1' });
    expect(director).toMatch(/^[0-9a-f]{32}$/);
    expect(director).not.toBe(traceIdForPlay('p1'));
    expect(traceIdForAttempt({ attemptId: 'director/s1' })).toBe(director);
    expect(traceIdForAttempt({})).toBeUndefined();
  });

  it('makes a session of the Director a tree of its own', () => {
    const log = new Log();
    const ids = { scenarioId: 's1', attemptId: 'director/s1' };
    log.add('session.opened', { sessionId: 'd1', executor: EXECUTOR }, ids);
    log.add('session.closed', { sessionId: 'd1', reason: 'completed' }, ids);
    log.add('attempt.cancelled', {}, ids);
    const spans = project(log.events);
    expect(spans.length).toBe(2);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(spans.every((span) => span.traceId !== traceIdForPlay('p1'))).toBe(true);
  });
});

describe('the waits that the log tells (P4, N217 (a))', () => {
  it('turns a wait for the quota reset into otheater.wait with the reason', () => {
    const log = new Log();
    log.add('play.created', { flowId: 'play' }, PLAY);
    log.add('session.opened', { sessionId: 's', executor: EXECUTOR }, ATTEMPT);
    const start = log.add(
      'attempt.reset_wait_started',
      { executor: EXECUTOR, cause: 'quota_exhausted', role: 'actor', resetsAt: T0 + 60_000 },
      ATTEMPT,
    );
    const end = log.add(
      'attempt.reset_wait_ended',
      { outcome: 'resumed', waitedMs: 600 },
      ATTEMPT,
      600,
    );
    const spans = project(log.events);
    const wait = byName(spans, SPAN_NAME.wait)[0]!;
    expect(wait.attributes).toMatchObject({
      [OT.waitKind]: WAIT_KIND.quota,
      [OT.waitReason]: 'quota_exhausted',
      [OT.waitOutcome]: 'resumed',
      [OT.waitOrigin]: 'log',
      [OT.profile]: 'main',
    });
    expect(wait.parentSpanId).toBe(attemptSpanId('p1/alpha/1'));
    expect(ms(wait.startTimeUnixNano)).toBe(start.timestamp);
    expect(ms(wait.endTimeUnixNano)).toBe(end.timestamp);
  });

  it('turns the wait of a demand for an Executor into one span with every reason', () => {
    const log = new Log();
    log.add('play.created', { flowId: 'play' }, PLAY);
    log.add('play.transitioned', { event: 'START', from: 'NEED', to: 'EXECUTING' }, PLAY);
    log.add(
      'demand.waiting',
      { demandId: 'alpha', role: 'actor', on: [{ reason: 'no_slot' }], since: T0 },
      PLAY,
    );
    log.add(
      'demand.waiting',
      { demandId: 'alpha', role: 'actor', on: [{ reason: 'quota' }], since: T0 },
      PLAY,
    );
    log.add('demand.resumed', { demandId: 'alpha', outcome: 'selected', waitedMs: 30 }, PLAY);
    const wait = byName(project(log.events), SPAN_NAME.wait)[0]!;
    expect(wait.attributes[OT.waitKind]).toBe(WAIT_KIND.executorSelection);
    expect(wait.attributes[OT.waitReason]).toBe('no_slot,quota');
    expect(wait.parentSpanId).not.toBeNull();
  });

  it('shows the wait for the semaphore of a heavy tool as a child of the call', () => {
    const log = new Log();
    log.add('session.opened', { sessionId: 's', executor: EXECUTOR }, ATTEMPT);
    log.add('tool.called', { callId: 'c', tool: 'run_tests', heavy: true }, ATTEMPT);
    log.add(
      'tool.finished',
      { callId: 'c', outcome: 'ok', durationMs: 20, queuedMs: 30 },
      ATTEMPT,
      100,
    );
    const spans = project(log.events);
    const call = spans.find((span) => span.name.startsWith('execute_tool'))!;
    const wait = byName(spans, SPAN_NAME.wait)[0]!;
    expect(wait.parentSpanId).toBe(call.spanId);
    expect(wait.attributes[OT.waitKind]).toBe(WAIT_KIND.toolSemaphore);
    expect(wait.attributes[OT.waitMs]).toBe(30);
    expect(wait.startTimeUnixNano).toBeGreaterThanOrEqual(call.startTimeUnixNano);
    expect(wait.endTimeUnixNano).toBeLessThanOrEqual(call.endTimeUnixNano);
  });

  it('turns a wait recorded where it happened into a span in the trace of its attempt', () => {
    const span = directWaitSpan({
      kind: WAIT_KIND.poolAdmission,
      key: 'p1/alpha/1|10|1',
      startMs: T0,
      endMs: T0 + 40,
      reason: 'max_sessions',
      outcome: 'admitted',
      correlation: {
        playId: 'p1',
        attemptId: 'p1/alpha/1',
        client: 'claude-code',
        profile: 'main',
      },
    });
    expect(span.name).toBe(SPAN_NAME.wait);
    expect(span.traceId).toBe(traceIdForPlay('p1'));
    expect(span.parentSpanId).toBe(attemptSpanId('p1/alpha/1'));
    expect(span.attributes).toMatchObject({
      [OT.waitReason]: 'max_sessions',
      [OT.waitMs]: 40,
      [OT.waitOrigin]: 'direct',
      [OT.profile]: 'main',
    });
  });

  it('gives a wait with no play and no attempt a trace of its own', () => {
    const wait = {
      kind: WAIT_KIND.promptQueue,
      key: 'prompt-1',
      startMs: T0,
      endMs: T0 + 5,
      reason: 'director_busy',
      outcome: 'delivered',
      correlation: { scenarioId: 's1' },
    } as const;
    const span = directWaitSpan(wait);
    expect(span.parentSpanId).toBeNull();
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(directWaitSpan(wait).spanId).toBe(span.spanId);
  });
});

describe('the watermark of the projection (P4)', () => {
  it('is the last event read when nothing is open, and the one before the oldest open span otherwise', () => {
    const log = new Log();
    const projection = new SpanProjection();
    log.add('play.created', { flowId: 'play' }, PLAY);
    log.add('session.opened', { sessionId: 's', executor: EXECUTOR }, ATTEMPT);
    for (const event of log.events) projection.apply(event);
    expect(projection.open).toBeGreaterThan(0);
    expect(projection.watermark(2)).toBe(0);
    const end = log.add(
      'play.transitioned',
      { event: 'CANCEL', from: 'NEED', to: 'CANCELLED' },
      PLAY,
    );
    projection.apply(end);
    expect(projection.open).toBe(0);
    expect(projection.watermark(end.id)).toBe(end.id);
  });

  it('is rebuilt from the watermark: reading from there gives the spans the first run had not written', () => {
    const { events } = wholePlay();
    const projection = new SpanProjection();
    const written: TelemetrySpan[] = [];
    for (const event of events.slice(0, 5)) written.push(...projection.apply(event));
    const mark = projection.watermark(5);
    const restarted = new SpanProjection();
    for (const event of events.filter((candidate) => candidate.id > mark)) {
      written.push(...restarted.apply(event));
    }
    const ids = (list: readonly TelemetrySpan[]): string[] =>
      [...new Set(list.map((span) => span.spanId))].sort();
    expect(ids(written)).toEqual(ids(project(events)));
  });
});
