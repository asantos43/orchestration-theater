// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import { InMemorySecretVault } from './in-memory-secret-vault.js';
import { InMemoryStore } from './in-memory-store.js';
import { Secret } from '../secret.js';
import { transactionInstant } from '../store-kit/instant.js';

const event = { type: 'test.happened', schemaVersion: 1, payload: {} };

// The shared contract is exercised by the suites of @otheater/sdk; here only what is specific to
// the fakes.
describe('InMemoryEventLog', () => {
  it('stamps events with the injected clock', async () => {
    const clock = new FakeClock(1000);
    const log = new InMemoryEventLog(clock);
    expect((await log.append(event)).timestamp).toBe(1000);
    await clock.advance(250);
    expect((await log.append(event)).timestamp).toBe(1250);
  });

  it('reuses the ids of a discarded overlay, and commit publishes it to the base', async () => {
    const base = new InMemoryEventLog(new FakeClock());
    await base.append(event);

    const dropped = base.fork();
    expect((await dropped.append(event)).id).toBe(2);
    dropped.discard();
    expect(await base.lastId()).toBe(1);

    const kept = base.fork();
    expect((await kept.append(event)).id).toBe(2);
    kept.commit();
    expect(await base.lastId()).toBe(2);
    await expect(kept.lastId()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('InMemoryStore', () => {
  it('shares the clock with its events', async () => {
    const clock = new FakeClock(5000);
    const store = new InMemoryStore({ clock });
    const stored = await store.transaction((tx) => tx.events.append(event));
    expect(stored.timestamp).toBe(5000);
  });

  it('reads a clock that moves once per transaction: the record and the event share the stamp (N177)', async () => {
    let ticks = 0;
    const store = new InMemoryStore({ clock: { now: () => 1000 + ticks++ } });
    const first = await store.transaction(async (tx) => {
      const scenario = await tx.scenarios.create({
        id: 'scn-1',
        kind: 'project',
        flowId: 'software',
        name: 'One',
        folder: '/tmp/scenarios/1',
      });
      const logged = await tx.events.append(event);
      const renamed = await tx.scenarios.update('scn-1', { name: 'Two' });
      return { scenario, logged, renamed, now: tx.now() };
    });
    expect(first.scenario.createdAt).toBe(1000);
    expect(first.logged.timestamp).toBe(1000);
    expect(first.renamed.updatedAt).toBe(1000);
    expect(first.now).toBe(1000);
    // The next transaction reads the clock again, and only once; one that stamps nothing does not.
    await store.transaction(() => Promise.resolve());
    const second = await store.transaction(async (tx) => {
      await tx.events.append(event);
      return tx.events.append(event);
    });
    expect(second.timestamp).toBe(1001);
  });
});

describe('transactionInstant', () => {
  it('is lazy and gives the first reading from then on', () => {
    let reads = 0;
    const instant = transactionInstant({ now: () => 7 + reads++ });
    expect(reads).toBe(0);
    expect([instant.now(), instant.now(), instant.now()]).toEqual([7, 7, 7]);
    expect(reads).toBe(1);
  });
});

describe('InMemorySecretVault', () => {
  it('can start locked', async () => {
    const vault = new InMemorySecretVault({ locked: true });
    await expect(vault.get('k')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    vault.unlock();
    await vault.set('k', new Secret('v'));
    expect((await vault.get('k'))?.reveal()).toBe('v');
  });

  it('returns a fresh Secret on every get', async () => {
    const vault = new InMemorySecretVault();
    await vault.set('k', new Secret('v'));
    expect(await vault.get('k')).not.toBe(await vault.get('k'));
  });
});
