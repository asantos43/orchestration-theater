// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import { startStalledPlays } from './open-play.js';

interface FakePlay {
  readonly state: string;
  readonly scenarioId: string;
}

function rig(plays: Record<string, FakePlay>, hasRepo = true) {
  const sent: [string, unknown][] = [];
  const based: string[] = [];
  const opening = {
    store: {
      plays: { get: (id: string) => Promise.resolve(plays[id]) },
      scenarioRepos: {
        list: () => Promise.resolve(hasRepo ? [{ path: '/repo', mainBranch: 'main' }] : []),
      },
    },
    runner: {
      create: vi.fn(),
      send: (id: string, event: unknown) => {
        sent.push([id, event]);
        return Promise.resolve(undefined);
      },
    },
    workspace: {
      createPlayBase: (input: { playId: string }) => {
        based.push(input.playId);
        return Promise.resolve('sha');
      },
    },
  };
  return { opening, sent, based };
}

const noop = (): void => undefined;

describe('startStalledPlays', () => {
  it('creates the base branch and sends START to a play still in NEED, and leaves the others', async () => {
    const { opening, sent, based } = rig({
      'play-a': { state: 'NEED', scenarioId: 's1' },
      'play-b': { state: 'WORK', scenarioId: 's1' },
    });
    const failed: string[] = [];
    const started = await startStalledPlays(opening as never, ['play-a', 'play-b'], (id) =>
      failed.push(id),
    );
    expect(started).toEqual(['play-a']);
    expect(based).toEqual(['play-a']);
    expect(sent).toEqual([['play-a', { type: 'START' }]]);
    expect(failed).toEqual([]);
  });

  it('does nothing when the daemon has no code host or the scenario has no repository', async () => {
    const noHost = rig({ 'play-a': { state: 'NEED', scenarioId: 's1' } });
    expect(
      await startStalledPlays(
        { ...noHost.opening, workspace: undefined } as never,
        ['play-a'],
        noop,
      ),
    ).toEqual([]);
    const noRepo = rig({ 'play-a': { state: 'NEED', scenarioId: 's1' } }, false);
    expect(await startStalledPlays(noRepo.opening as never, ['play-a'], noop)).toEqual([]);
    expect(noRepo.sent).toEqual([]);
  });

  it('reports the play that cannot be started and goes on with the next one', async () => {
    const { opening, sent } = rig({
      'play-a': { state: 'NEED', scenarioId: 's1' },
      'play-b': { state: 'NEED', scenarioId: 's1' },
    });
    const send = opening.runner.send;
    opening.runner.send = (id: string, event: unknown) =>
      id === 'play-a' ? Promise.reject(new Error('boom')) : send(id, event);
    const failed: string[] = [];
    const started = await startStalledPlays(opening as never, ['play-a', 'play-b'], (id) =>
      failed.push(id),
    );
    expect(failed).toEqual(['play-a']);
    expect(started).toEqual(['play-b']);
    expect(sent).toEqual([['play-b', { type: 'START' }]]);
  });
});
