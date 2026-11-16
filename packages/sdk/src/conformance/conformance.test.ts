// SPDX-License-Identifier: MPL-2.0
import {
  FakeClock,
  InMemoryEventLog,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import type { Clock } from '@otheater/core';
import { InvalidInput, Cancelled } from '@otheater/core';
import {
  describeClockConformance,
  describeEventLogConformance,
  describeSecretVaultConformance,
  describeStoreConformance,
} from '../index.js';

// The fakes of `@otheater/core/testing` must pass every suite: that is this step's test.

describeClockConformance('FakeClock', () => {
  const clock = new FakeClock();
  return { clock, advance: (ms) => clock.advance(ms) };
});

/**
 * Minimal real-time clock, only here to prove the suite is not tied to fake time (the real
 * adapter, with long-delay chunking, belongs to the daemon assembly, not to core).
 */
class TestSystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new InvalidInput('bad ms'));
    if (signal?.aborted === true) {
      return Promise.reject(new Cancelled('cancelled', { cause: signal.reason }));
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Cancelled('cancelled', { cause: signal?.reason }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describeClockConformance('real-time clock (test-only)', () => ({
  clock: new TestSystemClock(),
  advance: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms + 10);
    }),
}));

describeEventLogConformance('InMemoryEventLog', () => {
  const clock = new FakeClock();
  return { events: new InMemoryEventLog(clock), clock };
});

describeStoreConformance('InMemoryStore', () => {
  const clock = new FakeClock();
  return { store: new InMemoryStore({ clock }), clock };
});

describeSecretVaultConformance('InMemorySecretVault', () => {
  const vault = new InMemorySecretVault();
  return {
    vault,
    lock: () => {
      vault.lock();
    },
    unlock: () => {
      vault.unlock();
    },
  };
});
