// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory } from '../harness.js';
import { expectCode, type AggregateHarness } from './aggregate-support.js';
import {
  sampleDirective,
  samplePrompt,
  sampleSession,
  sampleSideEffect,
} from './coordination-aggregates.js';
import { sampleEvent } from './event-log.js';
import { deferred, rejectionOf, settle } from './helpers.js';
import { samplePlay } from './play-aggregates.js';
import { sampleAttachment, sampleScenario } from './scenario-aggregates.js';

/**
 * Registers the tests of how the aggregates of the store behave in a transaction, together with
 * the event log: read-your-writes, atomic rollback, a handle that outlived its transaction, a
 * store that was closed, and what is visible outside before the commit.
 */
export function describeAggregateTransactionsConformance(
  name: string,
  factory: AdapterFactory<AggregateHarness>,
): void {
  describe(`Aggregate transactions conformance: ${name}`, () => {
    const harness = useHarness(factory);

    it('a transaction reads its own writes in every aggregate and commits them together', async () => {
      const { store } = harness();
      await store.transaction(async (tx) => {
        await tx.scenarios.create(sampleScenario(1));
        await tx.plays.create(samplePlay(1));
        await tx.blackboard.put({ playId: 'play-1', key: 'plan', value: { n: 1 } });
        await tx.promptQueue.enqueue(samplePrompt('p1'));
        await tx.sideEffects.intend(sampleSideEffect('k1'));
        await tx.sessions.open(sampleSession('s1'));
        await tx.directives.create(sampleDirective());
        const attachment = await tx.attachments.add(sampleAttachment('scn-1'));

        expect((await tx.scenarios.get('scn-1'))?.name).toBe('Scenario 1');
        expect((await tx.plays.get('play-1'))?.need).toBe('Need 1');
        expect((await tx.blackboard.get('play-1', 'plan'))?.value).toEqual({ n: 1 });
        expect((await tx.promptQueue.next())?.id).toBe('p1');
        expect((await tx.sideEffects.get('k1'))?.state).toBe('pending');
        expect((await tx.sessions.get('s1'))?.state).toBe('active');
        expect((await tx.directives.inForce({ scenarioId: 'scn-1' })).map((d) => d.id)).toEqual([
          'O1',
        ]);
        expect(await tx.attachments.get('scn-1', attachment.id)).toEqual(attachment);
      });

      expect(await store.scenarios.get('scn-1')).toBeDefined();
      expect(await store.plays.get('play-1')).toBeDefined();
      expect(await store.blackboard.get('play-1', 'plan')).toBeDefined();
      expect(await store.promptQueue.get('p1')).toBeDefined();
      expect(await store.sideEffects.get('k1')).toBeDefined();
      expect(await store.sessions.get('s1')).toBeDefined();
      expect(await store.directives.get('O1')).toBeDefined();
      expect(await store.attachments.get('scn-1', 'A1')).toBeDefined();
    });

    it('a rollback drops events and aggregates together, and numbering starts over', async () => {
      const { store } = harness();
      await store.scenarios.create(sampleScenario(1));
      const failure = new Error('boom');
      const thrown = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.events.append(sampleEvent(1));
          await tx.plays.create(samplePlay(1));
          await tx.blackboard.put({ playId: 'play-1', key: 'plan', value: 1 });
          await tx.promptQueue.enqueue(samplePrompt('p1'));
          await tx.directives.create(sampleDirective());
          await tx.attachments.add(sampleAttachment('scn-1'));
          await tx.scenarios.update('scn-1', { name: 'Changed' });
          throw failure;
        }),
      );
      expect(thrown).toBe(failure);
      expect(await store.events.readFrom(0, 10)).toEqual([]);
      expect(await store.plays.get('play-1')).toBeUndefined();
      expect(await store.blackboard.get('play-1', 'plan')).toBeUndefined();
      expect(await store.promptQueue.list()).toEqual([]);
      expect(await store.directives.list()).toEqual([]);
      expect(await store.attachments.list('scn-1')).toEqual([]);
      expect((await store.scenarios.get('scn-1'))?.name).toBe('Scenario 1');

      expect((await store.directives.create(sampleDirective())).id).toBe('O1');
      expect((await store.attachments.add(sampleAttachment('scn-1'))).id).toBe('A1');
      expect(
        (await store.blackboard.put({ playId: 'play-1', key: 'plan', value: 2 })).version,
      ).toBe(1);
      expect((await store.promptQueue.enqueue(samplePrompt('p1'))).seq).toBe(1);
    });

    it('a failed write inside a transaction rolls back the writes before it', async () => {
      const { store } = harness();
      await store.plays.create(samplePlay(1));
      const thrown = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.sessions.open(sampleSession('s1'));
          await tx.plays.create(samplePlay(1));
        }),
      );
      expect(thrown).toMatchObject({ code: 'CONFLICT' });
      expect(await store.sessions.get('s1')).toBeUndefined();
    });

    it('writes outside a transaction commit on their own', async () => {
      const { store } = harness();
      await store.directives.create(sampleDirective());
      await store.blackboard.put({ playId: 'play-1', key: 'k', value: 1 });
      expect(await store.directives.get('O1')).toBeDefined();
      expect(await store.blackboard.latest('play-1')).toHaveLength(1);
    });

    it('rejects a handle used after its transaction ended with CONFLICT, in every aggregate', async () => {
      const { store } = harness();
      const leaked = await store.transaction((tx) => Promise.resolve(tx));
      const operations = [
        () => leaked.scenarios.get('scn-1'),
        () => leaked.scenarios.create(sampleScenario(1)),
        () => leaked.scenarioRepos.list('scn-1'),
        () => leaked.attachments.add(sampleAttachment('scn-1')),
        () => leaked.plays.get('play-1'),
        () => leaked.plays.create(samplePlay(1)),
        () => leaked.stages.list(),
        () => leaked.demands.list(),
        () => leaked.decisions.list(),
        () => leaked.blackboard.latest('play-1'),
        () => leaked.promptQueue.next(),
        () => leaked.sideEffects.get('k1'),
        () => leaked.sessions.list(),
        () => leaked.directives.refreshStates(),
      ];
      for (const operation of operations) {
        expect(await rejectionOf(operation())).toMatchObject({ code: 'CONFLICT' });
      }
      expect(await store.scenarios.list()).toEqual([]);
      expect(await store.plays.list()).toEqual([]);
    });

    it('after close() the aggregates reject with ADAPTER_UNAVAILABLE, reads and writes alike', async () => {
      const { store } = harness();
      await store.scenarios.create(sampleScenario(1));
      await store.close();
      const operations = [
        () => store.scenarios.get('scn-1'),
        () => store.scenarios.create(sampleScenario(2)),
        () => store.scenarioRepos.list('scn-1'),
        () => store.attachments.add(sampleAttachment('scn-1')),
        () => store.plays.list(),
        () => store.plays.create(samplePlay(1)),
        () => store.stages.list(),
        () => store.demands.list(),
        () => store.decisions.list(),
        () => store.blackboard.latest('play-1'),
        () => store.blackboard.put({ playId: 'play-1', key: 'k', value: 1 }),
        () => store.promptQueue.next(),
        () => store.promptQueue.enqueue(samplePrompt('p1')),
        () => store.sideEffects.list(),
        () => store.sessions.list(),
        () => store.directives.inForce({ scenarioId: 'scn-1' }),
        () => store.directives.create(sampleDirective()),
      ];
      for (const operation of operations) {
        await expectCode(operation(), 'ADAPTER_UNAVAILABLE');
      }
    });

    it('what a transaction writes is invisible outside until it commits, and appears whole', async () => {
      const { store } = harness();
      const midway = deferred();
      const release = deferred();
      const transaction = store.transaction(async (tx) => {
        await tx.plays.create(samplePlay(1));
        await tx.blackboard.put({ playId: 'play-1', key: 'plan', value: 1 });
        midway.release();
        await release.promise;
        await tx.directives.create(sampleDirective());
      });
      await midway.promise;

      // The outside reader may be answered now (nothing visible yet) or only after the commit
      // (adapters that make readers wait); it must never see half of the transaction.
      const outsidePlay = store.plays.get('play-1');
      const outsidePlan = store.blackboard.get('play-1', 'plan');
      await settle();
      release.release();
      await transaction;

      const seenPlay = await outsidePlay;
      const seenPlan = await outsidePlan;
      expect(seenPlay === undefined).toBe(seenPlan === undefined);
      expect(await store.plays.get('play-1')).toBeDefined();
      expect(await store.blackboard.get('play-1', 'plan')).toBeDefined();
      expect(await store.directives.get('O1')).toBeDefined();
    });

    it('a rolled-back transaction is never visible outside', async () => {
      const { store } = harness();
      const midway = deferred();
      const release = deferred();
      const transaction = store.transaction(async (tx) => {
        await tx.sideEffects.intend(sampleSideEffect('k1'));
        await tx.sessions.open(sampleSession('s1'));
        midway.release();
        await release.promise;
        throw new Error('rollback');
      });
      const outcome = transaction.then(
        () => 'committed',
        () => 'rolled back',
      );
      await midway.promise;

      const outsideEffect = store.sideEffects.get('k1');
      const outsideSessions = store.sessions.list();
      await settle();
      release.release();

      expect(await outcome).toBe('rolled back');
      expect(await outsideEffect).toBeUndefined();
      expect(await outsideSessions).toEqual([]);
    });

    it('transactions on aggregates are serialized: numbering never repeats', async () => {
      const { store } = harness();
      const created = await Promise.all([
        store.transaction((tx) => tx.directives.create(sampleDirective({ text: 'a' }))),
        store.transaction((tx) => tx.directives.create(sampleDirective({ text: 'b' }))),
        store.transaction((tx) => tx.attachments.add(sampleAttachment('scn-1', 'a.txt'))),
        store.transaction((tx) => tx.attachments.add(sampleAttachment('scn-1', 'b.txt'))),
        store.directives.create(sampleDirective({ text: 'c' })),
      ]);
      expect(created.slice(0, 2).map((d) => d.id)).toEqual(['O1', 'O2']);
      expect(created.slice(2, 4).map((a) => a.id)).toEqual(['A1', 'A2']);
      expect(created[4]).toMatchObject({ id: 'O3', text: 'c' });
    });
  });
}
