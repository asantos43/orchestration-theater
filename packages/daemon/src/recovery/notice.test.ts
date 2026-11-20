// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { ScenarioSystemMessagePayloadSchema } from '@otheater/protocol';
import { createSilentLogger } from '../logger.js';
import { announceRecovery, type RecoveryNoticeInput } from './notice.js';
import type { RecoveryReport } from './reconcile.js';

/**
 * The message of the reconciliation for the chat of each scenario it touched (architecture 5.21,
 * step 8): which scenarios, what each says, the record, and that a start with nothing to say
 * writes nothing.
 */

const EMPTY: RecoveryReport = {
  orphansKilled: 0,
  sessionsInterrupted: 0,
  wipCommits: 0,
  effectsResolved: 0,
  resolved: [],
  pending: [],
};
const NOTHING = { resumed: [], refused: [] };
const NO_ATTEMPTS = { resuming: [] };

let store: InMemoryStore;

function attempt(attemptId: string, playId: string): Parameters<Store['attempts']['put']>[0] {
  return {
    attemptId,
    playId,
    demandId: 'd1',
    attempt: 1,
    client: 'fake',
    profile: 'one',
    state: 'executing',
    cause: null,
    sessionId: null,
    worktree: `/work/${attemptId}`,
    branch: `b/${attemptId}`,
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
  };
}

function input(extra: Partial<RecoveryNoticeInput>): RecoveryNoticeInput {
  return {
    store,
    logger: createSilentLogger(),
    mode: 'always',
    recovery: EMPTY,
    plays: NOTHING,
    attempts: NO_ATTEMPTS,
    ...extra,
  };
}

async function systemMessages(): Promise<readonly unknown[]> {
  const events = await store.events.readFrom(0, 1000);
  return events.filter((event) => event.type === 'scenario.system_message');
}

beforeEach(async () => {
  store = new InMemoryStore({ clock: new FakeClock() });
  for (const id of ['s1', 's2']) {
    await store.scenarios.create({
      id,
      kind: 'project',
      flowId: 'play',
      name: id,
      folder: `/work/${id}`,
      baseBranch: 'main',
    });
  }
  for (const [id, scenarioId] of [
    ['p1', 's1'],
    ['p2', 's2'],
    ['p3', 's2'],
  ] as const) {
    await store.plays.create({
      id,
      scenarioId,
      need: 'need',
      flowId: 'play',
      flowVersion: 1,
      state: 'EXECUTING',
      counters: {},
    });
  }
  await store.attempts.put(attempt('p1:d1:1', 'p1'));
});

describe('announceRecovery', () => {
  it('writes nothing when the start-up found nothing to settle', async () => {
    expect(await announceRecovery(input({}))).toEqual([]);
    expect(await systemMessages()).toEqual([]);
  });

  it('writes nothing for what cannot be placed in a scenario', async () => {
    const notices = await announceRecovery(
      input({
        recovery: {
          ...EMPTY,
          pending: [{ key: 'k', effectType: 'open_pr', playId: null, reason: 'x' }],
        },
        plays: { resumed: ['gone'], refused: [] },
        attempts: { resuming: ['gone:d1:1'] },
      }),
    );
    expect(notices).toEqual([]);
    expect(await systemMessages()).toEqual([]);
  });

  it('says to each scenario only what happened in it, one event each', async () => {
    const notices = await announceRecovery(
      input({
        recovery: {
          ...EMPTY,
          effectsResolved: 1,
          resolved: [{ key: 'k1', effectType: 'open_pr', playId: 'p1', outcome: 'done' }],
          pending: [{ key: 'k2', effectType: 'merge_branch', playId: 'p2', reason: 'unknown' }],
        },
        plays: { resumed: ['p1', 'p3'], refused: ['p2'] },
        attempts: { resuming: ['p1:d1:1'] },
      }),
    );
    expect(notices).toEqual([
      {
        scenarioId: 's1',
        kind: 'recovery',
        resumed: [
          { kind: 'play', id: 'p1' },
          { kind: 'attempt', id: 'p1:d1:1' },
        ],
        settled: [{ effectType: 'open_pr', playId: 'p1', outcome: 'done' }],
        waiting: [],
      },
      {
        scenarioId: 's2',
        kind: 'recovery',
        resumed: [{ kind: 'play', id: 'p3' }],
        settled: [],
        waiting: [
          { kind: 'effect', id: 'k2', playId: 'p2', effectType: 'merge_branch' },
          { kind: 'play', id: 'p2', playId: 'p2', effectType: null },
        ],
      },
    ]);
    const events = await store.events.readFrom(0, 1000);
    const written = events.filter((event) => event.type === 'scenario.system_message');
    expect(written.map((event) => event.scenarioId)).toEqual(['s1', 's2']);
    // Each one is a valid event of the registry (`events.unknown_type: reject`).
    for (const event of written) {
      expect(ScenarioSystemMessagePayloadSchema.safeParse(event.payload).success).toBe(true);
    }
  });

  it('says nothing in the mode off, whatever happened', async () => {
    const notices = await announceRecovery(
      input({
        mode: 'off',
        recovery: { ...EMPTY, pending: [{ key: 'k', effectType: 'x', playId: 'p1', reason: 'r' }] },
        plays: { resumed: ['p1'], refused: [] },
      }),
    );
    expect(notices).toEqual([]);
    expect(await systemMessages()).toEqual([]);
  });

  it('tells only the scenarios with something settled or waiting in unclean_only', async () => {
    const notices = await announceRecovery(
      input({
        mode: 'unclean_only',
        recovery: {
          ...EMPTY,
          resolved: [{ key: 'k1', effectType: 'open_pr', playId: 'p2', outcome: 'done' }],
        },
        // s1 only took a play up again (a clean restart); s2 had an effect settled.
        plays: { resumed: ['p1', 'p2'], refused: [] },
      }),
    );
    expect(notices.map((notice) => notice.scenarioId)).toEqual(['s2']);
    expect(await systemMessages()).toHaveLength(1);
    const clean = await announceRecovery(
      input({ mode: 'unclean_only', plays: { resumed: ['p1'], refused: [] } }),
    );
    expect(clean).toEqual([]);
    expect(await systemMessages()).toHaveLength(1);
  });

  it('does not stop the start-up when a message cannot be written', async () => {
    const broken = {
      plays: store.plays,
      attempts: store.attempts,
      events: {
        append: () => Promise.reject(new Error('disk full')),
      },
    } as unknown as RecoveryNoticeInput['store'];
    const notices = await announceRecovery(
      input({ store: broken, plays: { resumed: ['p1'], refused: [] } }),
    );
    expect(notices).toEqual([]);
  });
});
