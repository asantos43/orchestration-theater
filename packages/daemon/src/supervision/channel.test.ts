// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { supervisionKey } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { SUPERVISION_TEXT_MAX } from '@otheater/protocol';
import type { SituationSink } from '../situations.js';
import { clipText, noticeLabel, SupervisionChannel } from './channel.js';
import { DEFAULT_SUPERVISION, type SupervisionSettings } from './config.js';

interface Recorded {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly attemptId: string | undefined;
  readonly scenarioId: string | undefined;
}

async function newStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore({ clock: new FakeClock(1_000) });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'need',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
  return store;
}

function channelOf(
  store: InMemoryStore,
  patch: Partial<SupervisionSettings> = {},
): { channel: SupervisionChannel; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const situations: SituationSink = {
    record: (type, payload, correlation) => {
      recorded.push({
        type,
        payload: payload as unknown as Record<string, unknown>,
        attemptId: correlation?.attemptId,
        scenarioId: correlation?.scenarioId,
      });
    },
  };
  let n = 0;
  const channel = new SupervisionChannel({
    store,
    situations,
    settings: () => ({ ...DEFAULT_SUPERVISION, ...patch }),
    newId: () => {
      n += 1;
      return `n${String(n)}`;
    },
  });
  return { channel, recorded };
}

const ctx = { playId: 'p1', demandId: 'a', attemptId: 'p1/a/1' };

describe('SupervisionChannel', () => {
  it('queues a notice, hands it once to the next tool reply and records both steps', async () => {
    const store = await newStore();
    const { channel, recorded } = channelOf(store);
    const queued = await channel.queue({ ...ctx, kind: 'warn', text: 'stay inside' });
    expect(queued).toMatchObject({ noticeId: 'n1', state: 'queued', turn: 0 });
    expect(await channel.pending('p1', 'a', 'p1/a/1')).toHaveLength(1);
    expect(await channel.pending('p1', 'a', 'p1/a/2')).toHaveLength(0);
    const taken = await channel.take(ctx);
    expect(taken.map((notice) => notice.text)).toEqual(['stay inside']);
    expect(await channel.take(ctx)).toEqual([]);
    expect(recorded.map((r) => [r.type, r.payload.delivered, r.payload.reason])).toEqual([
      ['supervision.warning', false, 'queued'],
      ['supervision.warning', true, 'delivered'],
    ]);
    expect(recorded[0]).toMatchObject({ attemptId: 'p1/a/1', scenarioId: 's1' });
  });

  it('hands a notice only to the attempt it is for', async () => {
    const { channel } = channelOf(await newStore());
    await channel.queue({ ...ctx, kind: 'warn', text: 'x' });
    expect(await channel.take({ ...ctx, attemptId: 'p1/a/2' })).toEqual([]);
  });

  it('never puts a redirect in a tool reply, and does not lose it when the attempt ends', async () => {
    const { channel, recorded } = channelOf(await newStore());
    await channel.queue({ ...ctx, kind: 'redirect', text: 'start over' });
    expect(await channel.take(ctx)).toEqual([]);
    await channel.endAttempt('p1', 'a', 'p1/a/1');
    expect(await channel.pending('p1', 'a', 'p1/a/1')).toEqual([]);
    expect(recorded.filter((r) => r.payload.reason === 'attempt_ended')).toEqual([]);
  });

  it('drops what the attempt never got, with delivered false and attempt_ended', async () => {
    const { channel, recorded } = channelOf(await newStore());
    await channel.queue({ ...ctx, kind: 'warn', text: 'late' });
    await channel.endAttempt('p1', 'a', 'p1/a/1');
    const last = recorded.at(-1);
    expect(last?.payload).toMatchObject({ delivered: false, reason: 'attempt_ended', kind: 'warn' });
    expect(await channel.take(ctx)).toEqual([]);
  });

  it('with next_turn holds the notice until the turn after the one it came in', async () => {
    const { channel } = channelOf(await newStore(), { delivery: 'next_turn' });
    await channel.queue({ ...ctx, kind: 'warn', text: 'later' });
    expect(await channel.take(ctx)).toEqual([]);
    channel.turnFinished('p1/a/1');
    expect(channel.turnOf('p1/a/1')).toBe(1);
    expect((await channel.take(ctx)).map((notice) => notice.text)).toEqual(['later']);
  });

  it('counts warnings and status requests per demand, and broadcasts per play', async () => {
    const { channel } = channelOf(await newStore());
    await channel.queue({ ...ctx, kind: 'warn', text: '1' });
    await channel.queue({ ...ctx, kind: 'contract', text: '2' });
    await channel.queue({ ...ctx, kind: 'status_request', text: '3' });
    await channel.queue({ ...ctx, kind: 'broadcast', text: '4' });
    expect(await channel.warnings('p1', 'a')).toBe(2);
    expect(await channel.statusRequests('p1', 'a')).toBe(1);
    expect(await channel.warnings('p1', 'b')).toBe(0);
    expect(channel.broadcasts('p1')).toBe(0);
    channel.countBroadcast('p1');
    expect(channel.broadcasts('p1')).toBe(1);
  });

  it('keeps the notices in the blackboard: a pending one survives a new channel (resume)', async () => {
    const store = await newStore();
    const first = channelOf(store).channel;
    await first.queue({ ...ctx, kind: 'warn', text: 'survive' });
    const delivered = await first.queue({ ...ctx, kind: 'warn', text: 'done' });
    await first.take({ ...ctx, attemptId: 'other' });
    const history = await store.blackboard.history('p1', supervisionKey('a'));
    expect(history).toHaveLength(2);

    const second = channelOf(store).channel;
    const pending = await second.pending('p1', 'a', 'p1/a/1');
    expect(pending.map((notice) => notice.text).sort()).toEqual(['done', 'survive']);
    expect((await second.take(ctx)).length).toBe(2);
    const third = channelOf(store).channel;
    expect(await third.pending('p1', 'a', 'p1/a/1')).toEqual([]);
    expect(await third.warnings('p1', 'a')).toBe(2);
    expect(delivered.noticeId).toBe('n2');
  });

  it('records nothing without a situation sink', async () => {
    const store = await newStore();
    const channel = new SupervisionChannel({
      store,
      situations: undefined,
      settings: () => DEFAULT_SUPERVISION,
    });
    const notice = await channel.queue({ ...ctx, kind: 'warn', text: 'quiet' });
    expect(notice.state).toBe('queued');
    expect(await channel.take(ctx)).toHaveLength(1);
  });
});

describe('clipText and noticeLabel', () => {
  it('clips a long text to the size of an event', () => {
    expect(clipText('short')).toBe('short');
    const clipped = clipText('x'.repeat(SUPERVISION_TEXT_MAX + 50));
    expect(clipped).toHaveLength(SUPERVISION_TEXT_MAX);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('gives a label to every kind', () => {
    expect(noticeLabel('warn')).toBe('warning');
    expect(noticeLabel('contract')).toBe('contract change');
    expect(noticeLabel('status_request')).toBe('status request');
    expect(noticeLabel('redirect')).toBe('redirect');
    expect(noticeLabel('broadcast')).toContain('every Actor');
  });
});
