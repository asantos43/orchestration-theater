// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { notesKey } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from './e2e-fixture.js';
import { itWithLauncher } from '../launcher-fixture.js';

/**
 * The notes board of a play (N308, option 1; P13 of Phase 11b), end to end with the fake agent.
 * The default script of the fake Scriptwriter has `alpha` and `beta`, and `beta` depends on
 * `alpha`: the Actor of `alpha` posts a note and the Actor of `beta`, which runs after it, reads
 * the board and writes what it read into `beta.txt`.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

async function deliveredPlay(harness: PlayHarness, need: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, need);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
  );
  return play.id;
}

async function typesOf(harness: PlayHarness, playId: string): Promise<string[]> {
  return (await harness.eventsOf(playId)).map((event) => event.type);
}

function beta(harness: PlayHarness, playId: string): Promise<string> {
  return testGit(harness.rig.repo, 'show', `play/${playId}/integration:beta.txt`);
}

describe('the notes board, end to end with the fake agent', { timeout: 120_000 }, () => {
  itWithLauncher('two Actors exchange a note, marked as data of another Actor', async () => {
    await withPlayDaemon(fakes(), {}, async (harness) => {
      const playId = await deliveredPlay(
        harness,
        '#ot-play write alpha #actor-note:alpha=use-utf-8 #actor-read-notes:beta',
      );
      const notes = await harness.daemon.store.blackboard.history(playId, notesKey('alpha'));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.value).toMatchObject({ text: 'use utf 8', demandId: 'alpha' });
      expect(await beta(harness, playId)).toContain('notes: use utf 8');
      expect(await typesOf(harness, playId)).toContain('note.posted');
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
    });
  });

  itWithLauncher('a note past max_per_actor is refused with collab.limit_reached', async () => {
    await withPlayDaemon(
      fakes(),
      { extra: 'collab:\n  notes:\n    max_per_actor: 1' },
      async (harness) => {
        const playId = await deliveredPlay(
          harness,
          '#ot-play write alpha #actor-note:alpha=first*2 #actor-read-notes:beta',
        );
        const notes = await harness.daemon.store.blackboard.history(playId, notesKey('alpha'));
        expect(notes).toHaveLength(1);
        const types = await typesOf(harness, playId);
        expect(types.filter((type) => type === 'note.posted')).toHaveLength(1);
        expect(types).toContain('collab.limit_reached');
        expect(await beta(harness, playId)).toContain('notes: first');
      },
    );
  });

  itWithLauncher('with mode off there is no board, and the play still delivers', async () => {
    await withPlayDaemon(
      fakes(),
      { extra: 'collab:\n  notes:\n    mode: off' },
      async (harness) => {
        const playId = await deliveredPlay(
          harness,
          '#ot-play write alpha #actor-note:alpha=hidden #actor-read-notes:beta',
        );
        expect(await harness.daemon.store.blackboard.history(playId, notesKey('alpha'))).toEqual(
          [],
        );
        expect(await beta(harness, playId)).not.toContain('notes:');
        expect(await typesOf(harness, playId)).not.toContain('note.posted');
      },
    );
  });
});
