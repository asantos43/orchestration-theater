// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { integrationBranch, type NewPlay } from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../config.js';
import type { PlayOpening } from '../../../orchestration/open-play.js';
import { createPlayRunPort } from './run-play-port.js';

const REPO = join('work', 'repo');

interface Rig {
  readonly store: InMemoryStore;
  readonly host: FakeCodeHost;
  readonly sent: { playId: string; event: unknown }[];
  readonly port: ReturnType<typeof createPlayRunPort>;
  /** The opening with a code host; set `workspace` to undefined to see the refusal. */
  readonly opening: PlayOpening;
}

async function makeRig(options: { repository?: boolean } = {}): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const host = new FakeCodeHost({ clock });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play',
    name: 's1',
    folder: REPO,
    baseBranch: 'main',
  });
  if (options.repository !== false) {
    await store.scenarioRepos.put({ scenarioId: 's1', path: REPO, mainBranch: 'main' });
  }
  const sent: Rig['sent'] = [];
  const opening: PlayOpening = {
    store,
    runner: {
      create: async (input) => {
        const play: NewPlay = {
          id: input.playId,
          scenarioId: input.scenarioId,
          need: input.need,
          flowId: 'play',
          flowVersion: 1,
          state: 'NEED',
        };
        return await store.plays.create(play);
      },
      send: async (playId, event) => {
        sent.push({ playId, event });
        return await store.plays.update(playId, { state: 'PLANNING' });
      },
    },
    workspace: {
      createPlayBase: () => Promise.resolve('branch'),
    },
    config: parseConfig(''),
  };
  return {
    store,
    host,
    sent,
    opening,
    port: createPlayRunPort({ opening, store, codeHost: host }),
  };
}

describe('the adapter of run_play over the orchestration', () => {
  it('opens the play with the id it was given and starts it, once', async () => {
    const rig = await makeRig();
    expect(await rig.port.exists('play-abcd1234')).toBe(false);
    const opened = await rig.port.open({
      playId: 'play-abcd1234',
      scenarioId: 's1',
      need: 'Fix the issue.',
    });
    expect(opened).toEqual({ ok: true });
    expect(await rig.port.exists('play-abcd1234')).toBe(true);
    expect((await rig.store.plays.get('play-abcd1234'))?.need).toBe('Fix the issue.');
    expect(rig.sent).toEqual([{ playId: 'play-abcd1234', event: { type: 'START' } }]);
    expect(await rig.port.outcome('play-abcd1234')).toBeUndefined();
  });

  it('passes the refusals of the orchestration on, with their code', async () => {
    const rig = await makeRig({ repository: false });
    expect(
      await rig.port.open({ playId: 'play-00000001', scenarioId: 's1', need: 'n' }),
    ).toMatchObject({ ok: false, code: 'no_repository' });
    expect(await rig.port.exists('play-00000001')).toBe(false);
  });

  it('a play that ended DONE with a pull request answers with its branch, number and url', async () => {
    const rig = await makeRig();
    await rig.port.open({ playId: 'play-0000000a', scenarioId: 's1', need: 'n' });
    const head = integrationBranch('play-0000000a');
    rig.host.seedRemote(REPO, 'main');
    rig.host.seedRemote(REPO, head);
    const pr = await rig.host.openPullRequest({
      repo: REPO,
      head,
      base: 'main',
      title: 'The work',
      body: '',
    });
    await rig.store.plays.update('play-0000000a', { state: 'DONE', finishedAt: 1 });
    const outcome = await rig.port.outcome('play-0000000a');
    expect(outcome).toMatchObject({
      state: 'DONE',
      branch: head,
      pullRequest: { number: pr.number, url: pr.url },
    });
    expect(outcome?.summary).toContain('ended DONE');
    expect(outcome?.summary).toContain(`Pull request #${String(pr.number)}`);
  });

  it('a play that ended DONE with only a branch on the remote answers with the branch', async () => {
    const rig = await makeRig();
    await rig.port.open({ playId: 'play-0000000b', scenarioId: 's1', need: 'n' });
    const head = integrationBranch('play-0000000b');
    rig.host.seedRemote(REPO, head);
    await rig.store.plays.update('play-0000000b', { state: 'DONE', finishedAt: 1 });
    expect(await rig.port.outcome('play-0000000b')).toMatchObject({
      state: 'DONE',
      branch: head,
      pullRequest: null,
    });
  });

  it('a play that ended CANCELLED answers with no branch and the last reason', async () => {
    const rig = await makeRig();
    await rig.port.open({ playId: 'play-0000000c', scenarioId: 's1', need: 'n' });
    await rig.store.plays.update('play-0000000c', {
      state: 'CANCELLED',
      finishedAt: 1,
      snapshot: { context: { feedback: 'the Critic said no' } },
    });
    const outcome = await rig.port.outcome('play-0000000c');
    expect(outcome).toMatchObject({ state: 'CANCELLED', branch: '', pullRequest: null });
    expect(outcome?.summary).toContain('Last reason: the Critic said no');
  });
});
