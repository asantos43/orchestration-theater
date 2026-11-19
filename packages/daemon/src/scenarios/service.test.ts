// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InvalidInput, type Vcs } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDaemonRegistries } from '../registries.js';
import { genericChatId, projectScenarioId, ScenarioService } from './service.js';

let root: string;
let store: InMemoryStore;
let inits: string[];

/** Only what the service uses: it can resolve `main` of a repo and make a folder a repo. */
const vcs = {
  resolveRef: (_repo: string, ref: string) =>
    ref === 'main' ? Promise.resolve('abc') : Promise.reject(new Error(`no ref ${ref}`)),
  findCommitByTrailer: () => Promise.resolve(undefined),
  init: (folder: string, options: { branch: string }) => {
    inits.push(folder);
    return Promise.resolve({ branch: options.branch });
  },
} as unknown as Vcs;

function service(): ScenarioService {
  return new ScenarioService({
    store,
    vcs,
    registries: buildDaemonRegistries(),
    scenariosDir: join(root, 'scenarios'),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-scenario-service-'));
  store = new InMemoryStore({ clock: new FakeClock() });
  inits = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('creating scenarios by type', () => {
  it('creates a project in the repository, with the default flow of the type', async () => {
    const { scenario, created } = await service().create({ type: 'project', repo: '/work/app' });
    expect(created).toBe(true);
    expect(scenario).toMatchObject({
      id: projectScenarioId('/work/app'),
      kind: 'project',
      flowId: 'play',
      // The service resolves the folder: on Windows it gains the drive of the current folder.
      folder: resolve('/work/app'),
      baseBranch: 'main',
    });
    expect(await store.scenarioRepos.list(scenario.id)).toMatchObject([
      { path: resolve('/work/app') },
    ]);
    const again = await service().create({ type: 'project', repo: '/work/app' });
    expect(again).toMatchObject({ created: false });
  });

  it('refuses a project without a repo, or with a base that does not exist', async () => {
    await expect(service().create({ type: 'project' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(
      service().create({ type: 'project', repo: '/work/app', base: 'nope' }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('creates a chat with its own folder, as a repository, and reopens it by name', async () => {
    const { scenario, created } = await service().create({ type: 'chat', name: 'Ideas' });
    expect(created).toBe(true);
    expect(scenario).toMatchObject({
      id: genericChatId('Ideas'),
      kind: 'chat',
      flowId: 'chat',
      profile: null,
    });
    expect(scenario.folder).toBe(join(root, 'scenarios', scenario.id));
    expect(inits).toEqual([scenario.folder]);
    expect(await store.scenarioRepos.list(scenario.id)).toEqual([]);
    expect(await service().create({ type: 'chat', name: 'Ideas' })).toMatchObject({
      created: false,
    });
    expect(inits).toHaveLength(1);
  });

  it('writes scenario.created once per scenario', async () => {
    await service().create({ type: 'chat' });
    await service().create({ type: 'chat' });
    const events = (await store.events.readFrom(0, 100)).filter(
      (event) => event.type === 'scenario.created',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ type: 'chat', flow: 'chat' });
  });

  it('refuses a type that is not registered, and one that cannot be created yet', async () => {
    await expect(service().create({ type: 'ghost' })).rejects.toThrow(/no scenario type "ghost"/);
    await expect(service().create({ type: 'task' })).rejects.toThrow(/cannot be created yet/);
  });
});
