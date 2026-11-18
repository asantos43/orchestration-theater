// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  QuotaExhausted,
  type AdapterImplements,
  type Disposable,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { RecordingSituations } from '../test-helpers.js';
import { QuotaService } from './service.js';
import type { QuotaSettings } from './settings.js';

/** The events beside the quota warnings of the log (P24, N146, N149). */

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const WORK = 'claude-code/work';

/** A probe the test shapes: it can watch or not, throw on `watch`, and count a usage or fail to. */
class ShapedProbe implements QuotaProbe {
  readonly id = 'shaped';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  watch?: (profile: ProfileRef, onChange: (reading: QuotaReading) => void) => Disposable;
  recordUsage?: () => void;

  capabilities(): QuotaCapabilities {
    return { windows: ['5h', '7d'], delivery: 'both', precision: 'exact' };
  }

  read(): Promise<QuotaReading> {
    return Promise.reject(new AdapterUnavailable('no quota source yet'));
  }
}

const started: QuotaService[] = [];

function setup(over: Partial<QuotaSettings> = {}) {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const situations = new RecordingSituations();
  const probe = new ShapedProbe();
  const service = new QuotaService({
    store,
    clock,
    settings: {
      nearLimitAt: 0.8,
      staleAfterMs: 10 * MIN,
      delivery: 'both',
      pollEveryMs: 5 * MIN,
      ...over,
    },
    logger: createSilentLogger(),
    situations,
  });
  service.addProbe('claude-code', probe);
  started.push(service);
  return { service, store, probe, situations };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
});

describe('QuotaService, what it also tells as events (P24, N146)', () => {
  it('quota.signal_dropped invalid_signal: a notification that does not parse', async () => {
    const { service, situations } = setup();
    const answer = await service.ingestNotification({
      sessionId: 's',
      signal: { kind: 'mystery' },
    });
    expect(answer).toBe(false);
    expect(situations.of('quota.signal_dropped')).toEqual([
      {
        reason: 'invalid_signal',
        profile: null,
        sessionId: null,
        detail: expect.stringContaining('issue(s) in the signal') as unknown,
      },
    ]);
  });

  it('quota.signal_dropped no_profile: a signal and a limit error of a session with no profile', async () => {
    const { service, situations } = setup();
    const signal = { kind: 'window', window: '5h', usedPercent: 50 } as const;
    expect(await service.ingestSignal('nobody', signal)).toBe(false);
    expect(await service.ingestError('nobody', new QuotaExhausted('over'))).toBe(false);
    expect(situations.of('quota.signal_dropped')).toEqual([
      { reason: 'no_profile', profile: null, sessionId: 'nobody' },
      { reason: 'no_profile', profile: null, sessionId: 'nobody', detail: 'a limit error' },
    ]);
  });

  it('quota.signal_dropped bad_reading: a reading that does not fit the schema', async () => {
    const { service, situations } = setup();
    await service.ingestReading(WORK, { observedAt: -1, windows: [] }, 'probe');
    expect(situations.of('quota.signal_dropped')).toEqual([
      {
        reason: 'bad_reading',
        profile: WORK,
        sessionId: null,
        detail: expect.stringContaining('issue(s) in the reading from probe') as unknown,
      },
    ]);
  });

  it('quota.signal_dropped usage_not_taken: a probe that cannot count a usage, the text masked', async () => {
    const { service, store, probe, situations } = setup();
    probe.recordUsage = (): void => {
      throw new Error(`ledger full, key sk-ant-api03-${'b'.repeat(40)}`);
    };
    await store.sessions.open({
      id: 's1',
      client: 'claude-code',
      profile: 'work',
      clientSessionId: null,
    });
    expect(await service.ingestUsage('s1', { kind: 'usage', outputTokens: 1 })).toBe(false);
    const [dropped] = situations.of('quota.signal_dropped') as { detail: string }[];
    expect(dropped).toMatchObject({ reason: 'usage_not_taken', profile: WORK, sessionId: 's1' });
    expect(dropped?.detail).toContain('ledger full');
    expect(dropped?.detail).not.toContain('sk-ant-api03-bbbb');
  });

  it('quota.probe_failed push_unsupported: delivery push with a probe that cannot watch', async () => {
    const { service, situations } = setup({ delivery: 'push' });
    service.track(WORK);
    await service.start();
    await flush();
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: WORK, reason: 'push_unsupported' },
    ]);
  });

  it('quota.probe_failed watch_failed: a probe whose watch throws', async () => {
    const { service, probe, situations } = setup({ delivery: 'push' });
    probe.watch = () => {
      throw new Error('no way to watch');
    };
    service.track(WORK);
    await service.start();
    await flush();
    expect(situations.of('quota.probe_failed')).toEqual([
      { profile: WORK, reason: 'watch_failed', detail: 'no way to watch' },
    ]);
  });

  it('says nothing when the probe is fine and the signals are good', async () => {
    const { service, situations } = setup({ delivery: 'poll' });
    await service.ingestReading(WORK, {
      observedAt: T0,
      windows: [
        { window: '5h', usedPercent: 10, resetsAt: T0 + 120 * MIN },
        { window: '7d', usedPercent: 10, resetsAt: T0 + 5000 * MIN },
      ],
    });
    expect(situations.recorded).toEqual([]);
  });
});
