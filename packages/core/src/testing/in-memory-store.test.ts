// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import { InMemorySecretVault } from './in-memory-secret-vault.js';
import { InMemoryStore } from './in-memory-store.js';
import { Secret } from '../secret.js';

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
