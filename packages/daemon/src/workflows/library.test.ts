// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput, NotFound, type JsonObject } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { PLAY_WORKFLOW } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS_SETTINGS, type WorkflowsSettings } from './config.js';
import { WorkflowLibrary, type WorkflowLibraryDeps } from './library.js';

function newStore(): InMemoryStore {
  return new InMemoryStore({ clock: new FakeClock() });
}

function newLibrary(
  store: InMemoryStore,
  settings: WorkflowsSettings = DEFAULT_WORKFLOWS_SETTINGS,
  extra: Partial<WorkflowLibraryDeps> = {},
): WorkflowLibrary {
  return new WorkflowLibrary({ store, settings: () => settings, ...extra });
}

/** The play with another version (and, optionally, another id): a valid document each time. */
function play(version: string, id = PLAY_WORKFLOW.id): unknown {
  return { ...PLAY_WORKFLOW, id, version };
}

async function openPlay(store: InMemoryStore, flowId: string): Promise<void> {
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId,
    name: 's1',
    folder: '/work/s1',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: 'p1',
    scenarioId: 's1',
    need: 'need',
    state: 'PLANNING',
    flowId,
    flowVersion: 1,
  });
}

describe('WorkflowLibrary.install', () => {
  it('validates the document, hashes it and activates the first version', async () => {
    const library = newLibrary(newStore());
    const saved = await library.install(PLAY_WORKFLOW, { source: 'builtin' });
    expect(saved).toMatchObject({
      workflowId: 'play',
      version: '2.0.0',
      source: 'builtin',
      packageId: null,
      state: 'active',
    });
    expect(saved.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await library.active('play')).toMatchObject({ version: '2.0.0' });
  });

  it('refuses a document that does not validate, saying where', async () => {
    const library = newLibrary(newStore());
    const bad = { ...PLAY_WORKFLOW, start: 'nowhere' };
    await expect(library.install(bad, { source: 'user' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(library.install(bad, { source: 'user' })).rejects.toThrow(/not valid/);
    expect(await library.list()).toEqual([]);
  });

  it('keeps the active version when a newer one is only saved, and switches on request', async () => {
    const library = newLibrary(newStore());
    await library.install(play('2.0.0'), { source: 'user' });
    const next = await library.install(play('2.1.0'), { source: 'user' });
    expect(next.state).toBe('inactive');
    expect(await library.active('play')).toMatchObject({ version: '2.0.0' });
    await library.install(play('2.2.0'), { source: 'user', activate: true });
    expect(await library.active('play')).toMatchObject({ version: '2.2.0' });
    const states = (await library.list({ workflowId: 'play' })).map((r) => [r.version, r.state]);
    expect(states).toEqual([
      ['2.0.0', 'inactive'],
      ['2.1.0', 'inactive'],
      ['2.2.0', 'active'],
    ]);
  });

  it('is idempotent for the same content and refuses other content under the same version', async () => {
    const library = newLibrary(newStore());
    const first = await library.install(PLAY_WORKFLOW, { source: 'builtin' });
    const again = await library.install(PLAY_WORKFLOW, { source: 'builtin' });
    expect(again.seq).toBe(first.seq);
    const changed = { ...PLAY_WORKFLOW, description: 'something else' };
    await expect(library.install(changed, { source: 'user' })).rejects.toBeInstanceOf(Conflict);
  });

  it('a package definition names its package, others do not', async () => {
    const library = newLibrary(newStore());
    const saved = await library.install(play('1.0.0', 'from-pkg'), {
      source: 'package',
      packageId: 'acme/workflows',
    });
    expect(saved.packageId).toBe('acme/workflows');
    await expect(
      library.install(play('1.0.0', 'orphan'), { source: 'package' }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('WorkflowLibrary.resolve', () => {
  async function filled(): Promise<WorkflowLibrary> {
    const library = newLibrary(newStore());
    for (const version of ['1.0.0', '1.2.0', '1.10.0', '2.0.0']) {
      await library.install(play(version), { source: 'user' });
    }
    await library.activate('play', '1.2.0');
    return library;
  }

  it('* is the active version', async () => {
    const library = await filled();
    expect((await library.resolve('play', '*'))?.version).toBe('1.2.0');
  });

  it('an exact version is that version, or nothing', async () => {
    const library = await filled();
    expect((await library.resolve('play', '2.0.0'))?.version).toBe('2.0.0');
    expect(await library.resolve('play', '3.0.0')).toBeUndefined();
  });

  it('a range takes the highest saved version that matches, comparing numbers', async () => {
    const library = await filled();
    expect((await library.resolve('play', '1.x'))?.version).toBe('1.10.0');
    expect((await library.resolve('play', '1.2.x'))?.version).toBe('1.2.0');
    expect(await library.resolve('play', '3.x')).toBeUndefined();
    expect(await library.resolve('other', '*')).toBeUndefined();
  });
});

describe('WorkflowLibrary.remove', () => {
  it('removes a saved version that is not active and has no live run', async () => {
    const store = newStore();
    const library = newLibrary(store);
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user' });
    await library.remove('play', '1.1.0');
    expect((await library.list()).map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('keeps the active version and unknown versions are not found', async () => {
    const library = newLibrary(newStore());
    await library.install(play('1.0.0'), { source: 'user' });
    await expect(library.remove('play', '1.0.0')).rejects.toBeInstanceOf(Conflict);
    await expect(library.remove('play', '9.9.9')).rejects.toBeInstanceOf(NotFound);
  });

  it('keeps an old version while a play of the workflow is not finished', async () => {
    const store = newStore();
    const library = newLibrary(store);
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user', activate: true });
    await openPlay(store, 'play');
    await expect(library.remove('play', '1.0.0')).rejects.toBeInstanceOf(Conflict);
    await store.plays.update('p1', { state: 'DONE', finishedAt: 5_000 });
    await library.remove('play', '1.0.0');
    expect((await library.list()).map((r) => r.version)).toEqual(['1.1.0']);
  });

  it('asks the injected probe when there is one, with the workflow and the version', async () => {
    const seen: string[] = [];
    const library = newLibrary(newStore(), DEFAULT_WORKFLOWS_SETTINGS, {
      liveRuns: (workflowId, version) => {
        seen.push(`${workflowId}@${version}`);
        return Promise.resolve(version === '1.0.0');
      },
    });
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user' });
    await library.install(play('1.2.0'), { source: 'user', activate: true });
    await expect(library.remove('play', '1.0.0')).rejects.toBeInstanceOf(Conflict);
    await library.remove('play', '1.1.0');
    expect(seen).toEqual(['play@1.0.0', 'play@1.1.0']);
  });
});

describe('the activation and the live runs by version (N295)', () => {
  it('tells the hook of the activation: the one that install makes and the one of activate', async () => {
    const told: string[] = [];
    const library = newLibrary(newStore(), DEFAULT_WORKFLOWS_SETTINGS, {
      onActivated: (workflowId, version) => {
        told.push(`${workflowId}@${version}`);
      },
    });
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user', activate: false });
    expect(told).toEqual(['play@1.0.0']);
    await library.install(play('1.2.0'), { source: 'user', activate: true });
    await library.activate('play', '1.1.0');
    expect(told).toEqual(['play@1.0.0', 'play@1.2.0', 'play@1.1.0']);
  });

  it('keeps the activation when the hook fails', async () => {
    const library = newLibrary(newStore(), DEFAULT_WORKFLOWS_SETTINGS, {
      onActivated: () => Promise.reject(new Error('the runtime is stopped')),
    });
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user' });
    await library.activate('play', '1.1.0');
    expect(await library.active('play')).toMatchObject({ version: '1.1.0' });
  });

  it('counts a run of the engine only in the version it is in now', async () => {
    const store = newStore();
    const library = newLibrary(store);
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user', activate: true });
    await openPlay(store, 'play');
    const inVersion = (version: string): { snapshot: JsonObject } => ({
      snapshot: { workflow: { id: 'play', version, hash: 'sha256:x' } },
    });
    await store.plays.update('p1', inVersion('1.1.0'));
    // Born in 1.0.0 and migrated to 1.1.0: the old version is free.
    await library.remove('play', '1.0.0');
    expect((await library.list()).map((r) => r.version)).toEqual(['1.1.0']);

    await library.install(play('1.2.0'), { source: 'user' });
    await store.plays.update('p1', inVersion('1.2.0'));
    await expect(library.remove('play', '1.2.0')).rejects.toBeInstanceOf(Conflict);
  });
});

describe('WorkflowLibrary.deactivate (P10b)', () => {
  it('leaves the workflow with no active version and lets the version be removed', async () => {
    const told: string[] = [];
    const store = newStore();
    const library = newLibrary(store, DEFAULT_WORKFLOWS_SETTINGS, {
      onDeactivated: (workflowId, version) => {
        told.push(`${workflowId}@${version}`);
      },
    });
    await library.install(play('1.0.0'), { source: 'user' });
    const off = await library.deactivate('play', '1.0.0');
    expect(off).toMatchObject({ state: 'inactive' });
    expect(await library.active('play')).toBeUndefined();
    expect(await library.resolve('play', '*')).toBeUndefined();
    // An exact version still resolves: a run keeps the version it is in.
    expect(await library.resolve('play', '1.0.0')).toMatchObject({ version: '1.0.0' });
    expect(told).toEqual(['play@1.0.0']);
    await library.remove('play', '1.0.0');
  });

  it('changes nothing for a version that is not the active one, and an unknown one is not found', async () => {
    const told: string[] = [];
    const library = newLibrary(newStore(), DEFAULT_WORKFLOWS_SETTINGS, {
      onDeactivated: () => {
        told.push('x');
      },
    });
    await library.install(play('1.0.0'), { source: 'user' });
    await library.install(play('1.1.0'), { source: 'user', activate: false });
    await library.deactivate('play', '1.1.0');
    expect(await library.active('play')).toMatchObject({ version: '1.0.0' });
    expect(told).toEqual([]);
    await expect(library.deactivate('play', '9.9.9')).rejects.toBeInstanceOf(NotFound);
  });

  it('keeps the deactivation when the hook fails, and activating again is the way back', async () => {
    const library = newLibrary(newStore(), DEFAULT_WORKFLOWS_SETTINGS, {
      onDeactivated: () => Promise.reject(new Error('boom')),
    });
    await library.install(play('1.0.0'), { source: 'user' });
    await library.deactivate('play', '1.0.0');
    expect(await library.active('play')).toBeUndefined();
    await library.activate('play', '1.0.0');
    expect(await library.active('play')).toMatchObject({ version: '1.0.0' });
  });
});

describe('workflows.default and workflows.allowed', () => {
  it('defaults to play and lets every installed workflow be chosen', () => {
    const library = newLibrary(newStore());
    expect(library.defaultWorkflowId()).toBe('play');
    expect(library.isAllowed('anything')).toBe(true);
    expect(() => {
      library.assertAllowed('anything');
    }).not.toThrow();
  });

  it('a list limits the choice to the listed workflows', () => {
    const library = newLibrary(newStore(), {
      ...DEFAULT_WORKFLOWS_SETTINGS,
      default: 'review-loop',
      allowed: ['play', 'review-loop'],
    });
    expect(library.defaultWorkflowId()).toBe('review-loop');
    expect(library.isAllowed('play')).toBe(true);
    expect(library.isAllowed('other')).toBe(false);
    expect(() => {
      library.assertAllowed('other');
    }).toThrow(InvalidInput);
  });

  it('reads the settings live', () => {
    let settings = DEFAULT_WORKFLOWS_SETTINGS;
    const library = new WorkflowLibrary({ store: newStore(), settings: () => settings });
    expect(library.isAllowed('x')).toBe(true);
    settings = { ...settings, allowed: ['play'] };
    expect(library.isAllowed('x')).toBe(false);
  });
});
