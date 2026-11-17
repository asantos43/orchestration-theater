// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { ProducerChannel, type ProducerChannelOptions } from './channel.js';
import { DECISION_KINDS } from './play-effects.js';

/**
 * The Producer's answer to a recovery question (architecture 5.21): an effect the start-up could
 * not check. The channel settles the record and puts the play back in motion.
 */

const PLAY = 'play-1';
const KEY = `${PLAY}:pr:play/${PLAY}/delivery:main`;
const DECISION = `${PLAY}:recovery:abc`;

let store: InMemoryStore;
let resumed: string[];
let channel: ProducerChannel;

beforeEach(async () => {
  store = new InMemoryStore({ clock: new FakeClock() });
  resumed = [];
  channel = new ProducerChannel({
    store,
    runner: {
      resume: (playId: string) => {
        resumed.push(playId);
        return Promise.resolve();
      },
    },
    board: { has: () => false },
    directors: { replies: () => [], busy: () => Promise.resolve(false) },
    logger: createSilentLogger(),
  } as unknown as ProducerChannelOptions);
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: PLAY,
    scenarioId: 's1',
    need: 'need',
    flowId: 'play',
    flowVersion: 1,
    state: 'DELIVERING',
    counters: {},
  });
  await store.sideEffects.intend({
    idempotencyKey: KEY,
    type: 'open_pr',
    target: 'x -> main',
    params: null,
  });
  await store.sideEffects.resolve(KEY, { state: 'ambiguous', verifier: null });
  await store.decisions.create({
    id: DECISION,
    scenarioId: 's1',
    playId: PLAY,
    kind: DECISION_KINDS.recovery,
    input: {
      key: KEY,
      effectType: 'open_pr',
      reason: 'no end record',
      options: ['not_done', 'done'],
    },
  });
});

describe('the recovery question in the chat', () => {
  it('is listed among what the Producer has to answer', async () => {
    const poll = await channel.poll('s1', 0);
    expect(poll.asks).toEqual([
      expect.objectContaining({ id: DECISION, kind: DECISION_KINDS.recovery, playId: PLAY }),
    ]);
    // The play waits for the answer: it is not "moving by itself".
    expect(poll.busy).toBe(false);
  });

  it('"not_done" lets the play do the effect again', async () => {
    await channel.answer(DECISION, { option: 'not_done' });
    expect(await store.sideEffects.get(KEY)).toMatchObject({
      state: 'not_done',
      verifier: 'producer',
    });
    expect((await store.decisions.get(DECISION))?.state).toBe('decided');
    expect(resumed).toEqual([PLAY]);
  });

  it('"done" takes the result the Producer gives, as an object', async () => {
    await channel.answer(DECISION, {
      option: 'done',
      result: { number: 7, url: 'https://code-host.invalid/pull/7' },
    });
    expect(await store.sideEffects.get(KEY)).toMatchObject({
      state: 'done',
      verifier: 'producer',
      result: { number: 7 },
    });
    expect(resumed).toEqual([PLAY]);
  });

  it('"done" with the result in the reason as JSON text', async () => {
    await channel.answer(DECISION, { option: 'done', reason: '{"number":9,"url":"u"}' });
    expect((await store.sideEffects.get(KEY))?.result).toEqual({ number: 9, url: 'u' });
  });

  it('"done" without a result is refused and nothing changes', async () => {
    await expect(channel.answer(DECISION, { option: 'done' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      channel.answer(DECISION, { option: 'done', reason: 'looks fine to me' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await store.sideEffects.get(KEY))?.state).toBe('ambiguous');
    expect((await store.decisions.get(DECISION))?.state).toBe('pending');
    expect(resumed).toEqual([]);
  });

  it('refuses an option that is neither', async () => {
    await expect(channel.answer(DECISION, { option: 'maybe' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(resumed).toEqual([]);
  });

  it('cannot be answered twice', async () => {
    await channel.answer(DECISION, { option: 'not_done' });
    await expect(channel.answer(DECISION, { option: 'not_done' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(resumed).toEqual([PLAY]);
  });
});
