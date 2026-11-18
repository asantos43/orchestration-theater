// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { QuotaService } from './service.js';

/**
 * The quota signals of the Claude Code adapter (P6) as the `QuotaService` takes them. The daemon
 * imports no adapter outside `compose.ts` (architecture 5.18), so the params below are written
 * out by hand: they are the output of `quotaSignalsOf` for the fake `rate_limit_event` of
 * `client-claude-code/src/quota-signal.test.ts`, which pins the same literals on the other side.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'claude-code/work';
const iso = (ms: number): string => new Date(ms).toISOString();

let clock: FakeClock;
let store: InMemoryStore;
let service: QuotaService;

beforeEach(() => {
  clock = new FakeClock(T0);
  store = new InMemoryStore({ clock });
  service = new QuotaService({
    store,
    clock,
    settings: { nearLimitAt: 0.8, staleAfterMs: 10 * MIN, delivery: 'both', pollEveryMs: 5 * MIN },
    logger: createSilentLogger(),
  });
  service.bindSession('s1', WORK);
});

afterEach(async () => {
  await service.stop();
});

describe('the Claude rate_limit_event signals in the QuotaService', () => {
  it('takes the window and limit_hit signals, and the profile is exhausted until the reset', async () => {
    const reset = T0 + 120 * MIN;
    const signals = [
      { kind: 'window', window: '5h', usedPercent: 100, resetsAt: iso(reset) },
      { kind: 'window', window: '7d', usedPercent: 12, resetsAt: iso(T0 + 4 * 1440 * MIN) },
      { kind: 'limit_hit', source: 'rate_limit_event', resetsAt: iso(reset) },
    ];
    for (const signal of signals) {
      expect(await service.ingestNotification({ sessionId: 's1', signal })).toBe(true);
    }
    expect(await service.statusOf(WORK)).toMatchObject({ state: 'exhausted', untilReset: reset });
    expect(await service.canUse(WORK)).toBe(false);
  });

  it('takes the window signals of an allowed event as a fresh reading, and 85% is near_limit', async () => {
    const signals = [
      { kind: 'window', window: '5h', usedPercent: 85, resetsAt: iso(T0 + 120 * MIN) },
      { kind: 'window', window: '7d', usedPercent: 12, resetsAt: iso(T0 + 4 * 1440 * MIN) },
    ];
    // The service expects the windows its probe declares; with no probe it asks for none.
    for (const signal of signals) await service.ingestNotification({ sessionId: 's1', signal });
    expect((await service.statusOf(WORK)).state).toBe('near_limit');
  });

  it('the limit_hit alone, with the default unit (no number), still exhausts the profile', async () => {
    const reset = T0 + 60 * MIN;
    const signal = { kind: 'limit_hit', source: 'rate_limit_event', resetsAt: iso(reset) };
    expect(await service.ingestNotification({ sessionId: 's1', signal })).toBe(true);
    expect(await service.statusOf(WORK)).toMatchObject({ state: 'exhausted', untilReset: reset });
  });
});
