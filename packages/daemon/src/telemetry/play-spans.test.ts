// SPDX-License-Identifier: MPL-2.0
import { NotFound, type TelemetrySpan } from '@otheater/core';
import { PlaySpansSchema } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryTelemetryStore } from './telemetry-fixture.js';
import { orderAsTree, playSpanKind, PlaySpansService } from './play-spans.js';

const DAEMON = { 'service.name': 'otheater', 'otheater.component': 'daemon' };
const NS = 1_000_000n;

function span(
  spanId: string,
  parentSpanId: string | null,
  name: string,
  startMs: number,
  endMs: number,
  attributes: Record<string, string | number | boolean> = {},
  extra: Partial<TelemetrySpan> = {},
): TelemetrySpan {
  return {
    traceId: 'a'.repeat(32),
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startTimeUnixNano: BigInt(startMs) * NS,
    endTimeUnixNano: BigInt(endMs) * NS,
    status: 'unset',
    statusMessage: null,
    attributes,
    resource: DAEMON,
    scenarioId: null,
    playId: 'p1',
    attemptId: null,
    sessionId: null,
    ...extra,
  };
}

/** A closed play: play > stage > attempt > session > tool, and a wait under the stage. */
function closedPlay(): TelemetrySpan[] {
  return [
    span('0000000000000001', null, 'otheater.play', 0, 1000, {
      'otheater.play.final_state': 'DONE',
    }),
    span('0000000000000002', '0000000000000001', 'otheater.stage', 10, 900, {
      'otheater.stage': 'WORKING',
    }),
    span(
      '0000000000000003',
      '0000000000000002',
      'invoke_agent coder',
      20,
      800,
      {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.id': 'att1',
        'otheater.role': 'coder',
        'otheater.client': 'claude-code',
        'otheater.profile': 'main',
      },
      { attemptId: 'att1' },
    ),
    span('0000000000000004', '0000000000000003', 'invoke_agent coder', 30, 790, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.conversation.id': 'c1',
      'gen_ai.agent.name': 'coder',
    }),
    span('0000000000000005', '0000000000000004', 'execute_tool Bash', 100, 140, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Bash',
      'otheater.tool.outcome': 'completed',
    }),
    span('0000000000000006', '0000000000000002', 'otheater.wait', 805, 850, {
      'otheater.wait.kind': 'approval',
      'otheater.wait.outcome': 'granted',
    }),
  ];
}

function service(spans: readonly TelemetrySpan[], known = true) {
  const store = new MemoryTelemetryStore();
  store.write({ spans });
  return new PlaySpansService({
    telemetry: store,
    plays: { get: (id) => Promise.resolve(known && id === 'p1' ? ({ id } as never) : undefined) },
  });
}

describe('playSpanKind', () => {
  it('tells the kinds apart by name and attributes', () => {
    expect(
      closedPlay()
        .slice(0, 6)
        .map((s) => playSpanKind(s)),
    ).toEqual(['play', 'stage', 'attempt', 'session', 'tool', 'wait']);
    expect(playSpanKind(span('0000000000000009', null, 'something.new', 0, 1))).toBe('other');
  });
});

describe('PlaySpansService', () => {
  it('lists the tree in depth-first order with depth, label, detail and durations', async () => {
    const result = PlaySpansSchema.parse(await service(closedPlay()).read('p1'));
    expect(result.playClosed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.spans.map((s) => [s.kind, s.depth, s.label, s.detail])).toEqual([
      ['play', 0, 'DONE', null],
      ['stage', 1, 'WORKING', null],
      ['attempt', 2, 'coder', 'claude-code/main'],
      ['session', 3, 'coder', null],
      ['tool', 4, 'Bash', 'completed'],
      ['wait', 2, 'approval', 'granted'],
    ]);
    const tool = result.spans.find((s) => s.kind === 'tool');
    expect(tool).toMatchObject({ startMs: 100, durationMs: 40, parentSpanId: '0000000000000004' });
    expect(result.spans.find((s) => s.kind === 'attempt')?.attemptId).toBe('att1');
  });

  it('marks a play that is still running: no play span, the stage becomes a root', async () => {
    const running = closedPlay().filter(
      (s) => s.name !== 'otheater.play' && s.name !== 'otheater.stage',
    );
    const result = await service(running).read('p1');
    expect(result.playClosed).toBe(false);
    // The attempt and the wait lost their parent (the stage is still open): both are roots.
    expect(result.spans.filter((s) => s.depth === 0).map((s) => s.kind)).toEqual([
      'attempt',
      'wait',
    ]);
    expect(result.spans.every((s) => s.depth > 0 || s.parentSpanId === null)).toBe(true);
  });

  it('keeps only the spans of the daemon, not those a client exported', async () => {
    const client = span(
      '00000000000000aa',
      null,
      'claude_code.interaction',
      0,
      5,
      {},
      {
        resource: { 'service.name': 'claude-code' },
      },
    );
    const result = await service([...closedPlay(), client]).read('p1');
    expect(result.spans.map((s) => s.spanId)).not.toContain('00000000000000aa');
    expect(result.spans).toHaveLength(6);
  });

  it('says it was truncated when the base had more than the limit', async () => {
    const result = await service(closedPlay()).read('p1', { limit: 4 });
    expect(result.truncated).toBe(true);
    expect(result.spans).toHaveLength(4);
    expect((await service(closedPlay()).read('p1', { limit: 6 })).truncated).toBe(false);
  });

  it('answers NotFound for a play the registry does not know', async () => {
    await expect(service(closedPlay()).read('nope')).rejects.toBeInstanceOf(NotFound);
  });

  it('gives an empty tree to a play with no span yet', async () => {
    const result = await service([]).read('p1');
    expect(result).toEqual({ playId: 'p1', spans: [], playClosed: false, truncated: false });
  });
});

describe('orderAsTree', () => {
  it('orders the children by start, then by id, and a span never appears twice', () => {
    const spans = [
      span('0000000000000001', null, 'otheater.play', 0, 100),
      span('0000000000000003', '0000000000000001', 'otheater.stage', 20, 30, {
        'otheater.stage': 'B',
      }),
      span('0000000000000002', '0000000000000001', 'otheater.stage', 10, 20, {
        'otheater.stage': 'A',
      }),
      span('0000000000000004', '0000000000000001', 'otheater.stage', 10, 20, {
        'otheater.stage': 'A2',
      }),
    ];
    expect(orderAsTree(spans).map((s) => s.label)).toEqual(['', 'A', 'A2', 'B']);
  });

  it('survives a cycle and a span that is its own parent', () => {
    const spans = [
      span('0000000000000001', '0000000000000002', 'otheater.stage', 0, 10),
      span('0000000000000002', '0000000000000001', 'otheater.stage', 1, 9),
      span('0000000000000003', '0000000000000003', 'otheater.stage', 2, 3),
    ];
    const out = orderAsTree(spans);
    // Only the self-parented span is a root; the two of the cycle are never reached.
    expect(out.map((s) => s.spanId)).toEqual(['0000000000000003']);
  });
});
