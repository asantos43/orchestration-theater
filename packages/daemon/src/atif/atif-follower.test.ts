// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import type { AtifSettings } from './atif-config.js';
import { AtifAutoExport } from './atif-follower.js';

/** The automatic export (P5, N219): when it fires for each `atif.export.on`. */

function event(
  id: number,
  type: string,
  fields: Partial<EventEnvelope> & { payload?: unknown } = {},
): EventEnvelope {
  return { id, type, ts: id, payload: {}, ...fields } as EventEnvelope;
}

async function run(
  on: AtifSettings['on'],
  events: readonly EventEnvelope[],
  failWith?: Error,
): Promise<{ calls: { playId: string; request: unknown }[]; warnings: unknown[] }> {
  const calls: { playId: string; request: unknown }[] = [];
  const warnings: unknown[] = [];
  let exported = 0;
  const auto = new AtifAutoExport({
    hub: {
      async *follow({ signal }) {
        for (const item of events) yield item;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    },
    exporter: {
      export: (playId, request) => {
        calls.push({ playId, request });
        exported += 1;
        if (failWith !== undefined) return Promise.reject(failWith);
        return Promise.resolve([]);
      },
    },
    settings: () => ({ unit: 'play', content: 'full', on, dir: 'trajectories' }),
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
  });
  auto.start();
  // the loop is sequential: wait until it has consumed every event, then stop it
  for (let i = 0; i < 50 && exported < expectedExports(on, events); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  await auto.stop();
  return { calls, warnings };
}

function expectedExports(on: AtifSettings['on'], events: readonly EventEnvelope[]): number {
  if (on === 'manual') return 0;
  return events.filter((e) =>
    on === 'play_end'
      ? e.type === 'play.transitioned' &&
        ['DONE', 'CANCELLED'].includes((e.payload as { to: string }).to)
      : e.type.startsWith('attempt.') && e.attemptId !== undefined,
  ).length;
}

const transition = (id: number, to: string, playId = 'p1'): EventEnvelope =>
  event(id, 'play.transitioned', { playId, payload: { event: 'x', from: 'A', to } });

describe('AtifAutoExport', () => {
  it('play_end: exports when the play reaches DONE or CANCELLED, once each, and not before', async () => {
    const { calls } = await run('play_end', [
      transition(1, 'PLANNING'),
      event(2, 'attempt.submitted', { playId: 'p1', attemptId: 'a1' }),
      transition(3, 'DONE'),
      transition(4, 'CANCELLED', 'p2'),
      event(5, 'play.need', { playId: 'p3' }),
    ]);
    expect(calls).toEqual([
      { playId: 'p1', request: { on: 'play_end' } },
      { playId: 'p2', request: { on: 'play_end' } },
    ]);
  });

  it('attempt_end: exports the attempt that submitted, was cancelled or aborted', async () => {
    const { calls } = await run('attempt_end', [
      transition(1, 'DONE'),
      event(2, 'attempt.submitted', { playId: 'p1', attemptId: 'a1' }),
      event(3, 'attempt.cancelled', { playId: 'p1', attemptId: 'a2' }),
      event(4, 'attempt.aborted', { playId: 'p1', attemptId: 'a3' }),
      event(5, 'attempt.started', { playId: 'p1', attemptId: 'a4' }),
    ]);
    expect(calls.map((call) => call.request)).toEqual([
      { on: 'attempt_end', attemptId: 'a1' },
      { on: 'attempt_end', attemptId: 'a2' },
      { on: 'attempt_end', attemptId: 'a3' },
    ]);
  });

  it('manual: exports nothing by itself', async () => {
    const { calls } = await run('manual', [transition(1, 'DONE')]);
    expect(calls).toEqual([]);
  });

  it('a failed export is only a warning and the next trigger still runs', async () => {
    const { calls, warnings } = await run(
      'play_end',
      [transition(1, 'DONE', 'p1'), transition(2, 'DONE', 'p2')],
      new Error('disk full'),
    );
    expect(calls.map((call) => call.playId)).toEqual(['p1', 'p2']);
    expect(warnings).toHaveLength(2);
  });
});
