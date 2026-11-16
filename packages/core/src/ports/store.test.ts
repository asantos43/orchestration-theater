// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock, InMemoryStore } from '../testing/index.js';
import { hasStoreMaintenance, type Store, type StoreMaintenance } from './store.js';

describe('hasStoreMaintenance', () => {
  it('is false for a store without the capability', () => {
    expect(hasStoreMaintenance(new InMemoryStore({ clock: new FakeClock() }))).toBe(false);
  });

  it('is true when quickCheck and backup exist', () => {
    const maintained: Store & StoreMaintenance = Object.assign(
      Object.create(new InMemoryStore({ clock: new FakeClock() })) as Store,
      {
        quickCheck: () => Promise.resolve([]),
        backup: () =>
          Promise.resolve({ path: '/x', bytes: 0, method: 'm', durationMs: 0, restarts: 0 }),
      },
    );
    expect(hasStoreMaintenance(maintained)).toBe(true);
  });

  it('is false when only one of the two exists', () => {
    const half = Object.assign(
      Object.create(new InMemoryStore({ clock: new FakeClock() })) as Store,
      {
        quickCheck: () => Promise.resolve([]),
      },
    );
    expect(hasStoreMaintenance(half)).toBe(false);
  });
});
