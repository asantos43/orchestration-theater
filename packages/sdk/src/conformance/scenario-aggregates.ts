// SPDX-License-Identifier: MPL-2.0
import type { NewAttachment, NewScenario, NewScenarioRepo } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';

/** A valid scenario; `n` varies the id. */
export function sampleScenario(n: number, extra: Partial<NewScenario> = {}): NewScenario {
  return {
    id: `scn-${String(n)}`,
    kind: 'project',
    flowId: 'software',
    name: `Scenario ${String(n)}`,
    folder: `/tmp/scenarios/${String(n)}`,
    ...extra,
  };
}

export function sampleRepo(scenarioId: string, path = '/tmp/repo'): NewScenarioRepo {
  return { scenarioId, path, mainBranch: 'main' };
}

export function sampleAttachment(scenarioId: string, name = 'spec.pdf'): NewAttachment {
  return {
    scenarioId,
    name,
    mime: 'application/pdf',
    size: 1024,
    hash: 'sha256:abc',
    source: 'copy',
    path: `/tmp/scenarios/${scenarioId}/attachments/${name}`,
  };
}

/**
 * Registers the conformance tests of `store.scenarios`, `store.scenarioRepos` and
 * `store.attachments`: create/get/list/update, validation, defaults, numbering of attachments.
 */
export function describeScenarioAggregatesConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Scenarios conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('get resolves undefined for an unknown scenario', async () => {
      expect(await harness().store.scenarios.get('nope')).toBeUndefined();
    });

    it('create stores a project with the defaults and stamps the dates', async () => {
      const { store, clock } = harness();
      const stored = await store.scenarios.create(sampleScenario(1));
      expect(stored).toEqual({
        ...sampleScenario(1),
        profile: null,
        conventions: null,
        baseBranch: null,
        configOverride: {},
        originScenarioId: null,
        directorState: 'active',
        state: 'active',
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      expect(await store.scenarios.get('scn-1')).toEqual(stored);
    });

    it('keeps the structured fields of a scenario as given', async () => {
      const { store } = harness();
      const stored = await store.scenarios.create(
        sampleScenario(1, {
          profile: 'software',
          conventions: { language: 'ts', scripts: ['build', 'test'], nested: { ok: true } },
          baseBranch: 'develop',
          configOverride: { 'review.max_rounds': 5 },
          originScenarioId: 'scn-0',
        }),
      );
      expect(await store.scenarios.get('scn-1')).toEqual(stored);
      expect(stored.conventions).toEqual({
        language: 'ts',
        scripts: ['build', 'test'],
        nested: { ok: true },
      });
      expect(stored.configOverride).toEqual({ 'review.max_rounds': 5 });
    });

    it('a duplicate id rejects with CONFLICT and keeps the first scenario', async () => {
      const { store } = harness();
      await store.scenarios.create(sampleScenario(1));
      await expectCode(store.scenarios.create(sampleScenario(1, { name: 'Other' })), 'CONFLICT');
      expect((await store.scenarios.get('scn-1'))?.name).toBe('Scenario 1');
    });

    it('rejects invalid input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(
        store.scenarios.create(sampleScenario(1, { kind: 'nope' as never })),
        'INVALID_INPUT',
      );
      await expectCode(store.scenarios.create(sampleScenario(1, { name: '' })), 'INVALID_INPUT');
      await expectCode(
        store.scenarios.create({ ...sampleScenario(1), extra: 1 } as never),
        'INVALID_INPUT',
      );
      expect(await store.scenarios.list()).toEqual([]);
    });

    it('list is ordered by creation, then id, and filters by kind and state', async () => {
      const { store } = harness();
      await store.scenarios.create(sampleScenario(2, { kind: 'task' }));
      await store.scenarios.create(sampleScenario(1));
      await store.scenarios.create(sampleScenario(3, { kind: 'chat', state: 'archived' }));
      expect((await store.scenarios.list()).map((s) => s.id)).toEqual(['scn-1', 'scn-2', 'scn-3']);
      expect((await store.scenarios.list({ kinds: ['task', 'chat'] })).map((s) => s.id)).toEqual([
        'scn-2',
        'scn-3',
      ]);
      expect((await store.scenarios.list({ states: ['archived'] })).map((s) => s.id)).toEqual([
        'scn-3',
      ]);
      expect(await store.scenarios.list({ kinds: [] })).toEqual([]);
    });

    it('update changes only the allowed fields', async () => {
      const { store } = harness();
      const first = await store.scenarios.create(sampleScenario(1));
      const updated = await store.scenarios.update('scn-1', {
        name: 'Renamed',
        directorState: 'asleep',
        configOverride: { a: 1 },
        conventions: { x: [1, 2] },
      });
      expect(updated).toMatchObject({
        id: 'scn-1',
        kind: 'project',
        name: 'Renamed',
        directorState: 'asleep',
        configOverride: { a: 1 },
        conventions: { x: [1, 2] },
        createdAt: first.createdAt,
      });
      expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      expect(await store.scenarios.get('scn-1')).toEqual(updated);

      const cleared = await store.scenarios.update('scn-1', { conventions: null });
      expect(cleared.conventions).toBeNull();
    });

    it('update rejects an unknown id with NOT_FOUND and a field outside the patch with INVALID_INPUT', async () => {
      const { store } = harness();
      await store.scenarios.create(sampleScenario(1));
      await expectCode(store.scenarios.update('nope', { name: 'x' }), 'NOT_FOUND');
      await expectCode(store.scenarios.update('scn-1', { id: 'other' } as never), 'INVALID_INPUT');
      await expectCode(store.scenarios.update('scn-1', { kind: 'chat' } as never), 'INVALID_INPUT');
    });

    it('stores a scenario with text that needs escaping', async () => {
      const { store } = harness();
      const tricky = `O'Brien "quoted" \\ back; -- comment\nnew line`;
      await store.scenarios.create(sampleScenario(1, { name: tricky, folder: '/tmp/ü/日本' }));
      expect(await store.scenarios.get('scn-1')).toMatchObject({
        name: tricky,
        folder: '/tmp/ü/日本',
      });
    });
  });

  describe(`Scenario repositories conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('put inserts a repository and get/list find it', async () => {
      const { store } = harness();
      const stored = await store.scenarioRepos.put({
        ...sampleRepo('scn-1'),
        remote: 'git@example.com:acme/app.git',
      });
      expect(stored).toMatchObject({
        scenarioId: 'scn-1',
        path: '/tmp/repo',
        remote: 'git@example.com:acme/app.git',
        mainBranch: 'main',
      });
      expect(await store.scenarioRepos.get('scn-1', '/tmp/repo')).toEqual(stored);
      expect(await store.scenarioRepos.list('scn-1')).toEqual([stored]);
      expect(await store.scenarioRepos.get('scn-1', '/other')).toBeUndefined();
    });

    it('put on an existing repository replaces it and keeps createdAt', async () => {
      const { store } = harness();
      const first = await store.scenarioRepos.put(sampleRepo('scn-1'));
      const second = await store.scenarioRepos.put({
        ...sampleRepo('scn-1'),
        remote: 'origin',
        mainBranch: 'trunk',
      });
      expect(second).toMatchObject({ remote: 'origin', mainBranch: 'trunk' });
      expect(second.createdAt).toBe(first.createdAt);
      expect(await store.scenarioRepos.list('scn-1')).toEqual([second]);
    });

    it('list is per scenario and remove says whether it removed something', async () => {
      const { store } = harness();
      await store.scenarioRepos.put(sampleRepo('scn-1', '/b'));
      await store.scenarioRepos.put(sampleRepo('scn-1', '/a'));
      await store.scenarioRepos.put(sampleRepo('scn-2', '/c'));
      expect((await store.scenarioRepos.list('scn-1')).map((r) => r.path)).toEqual(['/a', '/b']);
      expect(await store.scenarioRepos.remove('scn-1', '/a')).toBe(true);
      expect(await store.scenarioRepos.remove('scn-1', '/a')).toBe(false);
      expect((await store.scenarioRepos.list('scn-1')).map((r) => r.path)).toEqual(['/b']);
      expect((await store.scenarioRepos.list('scn-2')).map((r) => r.path)).toEqual(['/c']);
    });

    it('rejects invalid input with INVALID_INPUT', async () => {
      const { store } = harness();
      await expectCode(
        store.scenarioRepos.put({ ...sampleRepo('scn-1'), mainBranch: '' }),
        'INVALID_INPUT',
      );
    });
  });

  describe(`Attachments conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('add numbers the attachments A1, A2, A3 of a scenario', async () => {
      const { store } = harness();
      const a = await store.attachments.add(sampleAttachment('scn-1', 'a.pdf'));
      const b = await store.attachments.add({
        ...sampleAttachment('scn-1', 'b.png'),
        mime: 'image/png',
      });
      const c = await store.attachments.add(sampleAttachment('scn-1', 'c.pdf'));
      expect([a.id, b.id, c.id]).toEqual(['A1', 'A2', 'A3']);
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
      expect(b).toMatchObject({ mime: 'image/png', size: 1024, source: 'copy', messageId: null });
    });

    it('numbering is independent in each scenario', async () => {
      const { store } = harness();
      await store.attachments.add(sampleAttachment('scn-1'));
      await store.attachments.add(sampleAttachment('scn-1'));
      const other = await store.attachments.add(sampleAttachment('scn-2'));
      expect(other.id).toBe('A1');
      expect((await store.attachments.add(sampleAttachment('scn-1'))).id).toBe('A3');
    });

    it('get and list find the attachments, in numeric order', async () => {
      const { store } = harness();
      for (let n = 1; n <= 11; n++) {
        await store.attachments.add(sampleAttachment('scn-1', `f${String(n)}.txt`));
      }
      expect((await store.attachments.get('scn-1', 'A10'))?.name).toBe('f10.txt');
      expect(await store.attachments.get('scn-1', 'A12')).toBeUndefined();
      expect(await store.attachments.get('scn-2', 'A1')).toBeUndefined();
      expect((await store.attachments.list('scn-1')).map((a) => a.id)).toEqual(
        Array.from({ length: 11 }, (_, i) => `A${String(i + 1)}`),
      );
      expect(await store.attachments.list('scn-2')).toEqual([]);
    });

    it('keeps the message an attachment came with', async () => {
      const { store } = harness();
      const stored = await store.attachments.add({
        ...sampleAttachment('scn-1'),
        messageId: 'msg-7',
        source: 'reference',
      });
      expect(await store.attachments.get('scn-1', 'A1')).toEqual(stored);
      expect(stored).toMatchObject({ messageId: 'msg-7', source: 'reference' });
    });

    it('rejects invalid input with INVALID_INPUT and does not use up a number', async () => {
      const { store } = harness();
      await expectCode(
        store.attachments.add({ ...sampleAttachment('scn-1'), size: -1 }),
        'INVALID_INPUT',
      );
      await expectCode(
        store.attachments.add({ ...sampleAttachment('scn-1'), source: 'link' as never }),
        'INVALID_INPUT',
      );
      expect((await store.attachments.add(sampleAttachment('scn-1'))).id).toBe('A1');
    });
  });
}
