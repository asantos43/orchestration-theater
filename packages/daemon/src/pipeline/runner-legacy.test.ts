// SPDX-License-Identifier: MPL-2.0
import type { PlayRecord } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION } from './definitions.js';
import type { PlayEffect, PlayEffects } from './effects.js';
import { PlayRunner } from './runner.js';

/**
 * The snapshot of the `play` 1.x at start-up (Phase 11b, P3; D2/N311): there is no migration, and
 * `workflows.legacy_snapshot` says whether it is refused (`reject`) or cancelled (`cancel`).
 */

class FakeEffects implements PlayEffects {
  readonly dispatched: PlayEffect[] = [];
  dispatch(effect: PlayEffect): Promise<void> {
    this.dispatched.push(effect);
    return Promise.resolve();
  }
}

const quiet = { warn: () => undefined };

async function rig(mode: 'reject' | 'cancel' | undefined) {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const effects = new FakeEffects();
  const finished: PlayRecord[] = [];
  const runner = new PlayRunner({
    store,
    clock,
    effects,
    logger: quiet,
    ...(mode === undefined ? {} : { legacySnapshot: mode }),
    onFinish: (play) => finished.push(play),
  });
  await store.transaction(async (tx) => {
    await tx.plays.create({
      id: 'old',
      scenarioId: 's1',
      need: 'an old play',
      flowId: PLAY_FLOW_ID,
      flowVersion: PLAY_FLOW_VERSION - 1,
      state: 'EXECUTING',
      snapshot: { status: 'active', value: 'EXECUTING', context: { flowVersion: 1 } },
      counters: {},
    });
  });
  return { store, effects, runner, finished };
}

async function eventsOf(store: InMemoryStore, type: string) {
  return (await store.events.readFrom(0, 100)).filter((event) => event.type === type);
}

describe('PlayRunner.resumeAll over a play of the 1.x', () => {
  let runner: PlayRunner | undefined;
  afterEach(async () => {
    await runner?.close();
  });

  it('reject (the default): the play is not touched, and the refusal is an event and a notice', async () => {
    const r = await rig(undefined);
    runner = r.runner;
    const before = await r.store.plays.get('old');
    expect(await r.runner.resumeAll()).toEqual({ resumed: [], refused: ['old'] });
    await r.runner.idle();
    expect(await r.store.plays.get('old')).toEqual(before);
    expect(r.effects.dispatched).toEqual([]);
    const rejected = await eventsOf(r.store, 'workflow.snapshot_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      scenarioId: 's1',
      playId: 'old',
      payload: {
        flowId: PLAY_FLOW_ID,
        savedVersion: PLAY_FLOW_VERSION - 1,
        currentVersion: PLAY_FLOW_VERSION,
        mode: 'reject',
      },
    });
    const notices = await eventsOf(r.store, 'play.notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ playId: 'old', kind: 'play_not_resumed' });
    expect(r.finished).toEqual([]);
  });

  it('cancel: the play ends CANCELLED, is recorded, and the end is told', async () => {
    const r = await rig('cancel');
    runner = r.runner;
    expect(await r.runner.resumeAll()).toEqual({ resumed: [], refused: ['old'] });
    await r.runner.idle();
    const after = await r.store.plays.get('old');
    expect(after?.state).toBe('CANCELLED');
    expect(after?.finishedAt).not.toBeNull();
    expect(r.effects.dispatched).toEqual([]);
    const rejected = await eventsOf(r.store, 'workflow.snapshot_rejected');
    expect(rejected.map((event) => event.payload)).toEqual([
      {
        flowId: PLAY_FLOW_ID,
        savedVersion: PLAY_FLOW_VERSION - 1,
        currentVersion: PLAY_FLOW_VERSION,
        mode: 'cancel',
      },
    ]);
    expect(await eventsOf(r.store, 'play.notice')).toHaveLength(1);
    expect(r.finished.map((play) => play.id)).toEqual(['old']);
    // a second start finds nothing open
    expect(await r.runner.resumeAll()).toEqual({ resumed: [], refused: [] });
  });

  it('a record of another flow is a run of the generic engine: neither resumed nor refused', async () => {
    const r = await rig('reject');
    runner = r.runner;
    await r.store.transaction(async (tx) => {
      await tx.plays.create({
        id: 'run1',
        scenarioId: 's1',
        need: 'a generic run',
        flowId: 'triage',
        flowVersion: 1,
        state: 'fetch',
        snapshot: { workflow: { id: 'triage', version: '1.0.0', hash: 'sha256:x' } },
        counters: {},
      });
    });
    expect(await r.runner.resumeAll()).toEqual({ resumed: [], refused: ['old'] });
    await r.runner.idle();
    expect(await eventsOf(r.store, 'play.notice')).toHaveLength(1);
    expect((await r.store.plays.get('run1'))?.state).toBe('fetch');
  });
});
