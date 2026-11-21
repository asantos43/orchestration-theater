// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';
import { createConfigReloader } from './config-reload.js';
import { captureLogger } from './test-helpers.js';

const NEXT = parseConfig('limits:\n  preset: persistent\npool:\n  max_sessions: 9\n');

function rig(onHot?: (hot: readonly string[]) => Promise<void> | void) {
  const store = new InMemoryStore({ clock: new FakeClock() });
  const live = parseConfig('');
  const captured = captureLogger();
  const reloader = createConfigReloader({
    config: live,
    events: store.events,
    logger: captured.logger,
    onHot,
  });
  const changed = async () =>
    (await store.events.readFrom(0, 100)).filter((event) => event.type === 'config.changed');
  return { live, reloader, changed, lines: captured.lines };
}

describe('the reload of a write of the configuration (P23)', () => {
  it('takes in the hot paths, leaves the restart ones and writes config.changed once', async () => {
    const { live, reloader, changed } = rig();
    const result = await reloader.reload({
      next: NEXT,
      paths: ['limits.preset', 'pool.max_sessions'],
    });
    expect(result).toEqual({
      hot: ['limits.preset'],
      restart: ['pool.max_sessions'],
      appliesOn: 'mixed',
    });
    expect(live.limits.preset).toBe('persistent');
    expect(live.pool.max_sessions).not.toBe(9);
    const events = await changed();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ hot: ['limits.preset'], restart: ['pool.max_sessions'] });
  });

  it('changes nothing and writes no event when no path is hot', async () => {
    const onHot = vi.fn();
    const { live, reloader, changed } = rig(onHot);
    const result = await reloader.reload({ next: NEXT, paths: ['pool.max_sessions'] });
    expect(result).toEqual({ hot: [], restart: ['pool.max_sessions'], appliesOn: 'restart' });
    expect(live.limits.preset).not.toBe('persistent');
    expect(onHot).not.toHaveBeenCalled();
    expect(await changed()).toHaveLength(0);
  });

  it('apply and announce are separate, so a caller can write its own event in between', async () => {
    const { reloader, changed } = rig();
    const result = await reloader.apply({ next: NEXT, paths: ['limits.preset'] });
    expect(await changed()).toHaveLength(0);
    await reloader.announce(result);
    expect(await changed()).toHaveLength(1);
  });

  it('keeps the paths hot, and logs, when what the daemon re-reads fails', async () => {
    const { live, reloader, changed, lines } = rig(() => {
      throw new Error('caps are down');
    });
    const result = await reloader.reload({ next: NEXT, paths: ['limits.preset'] });
    expect(result.appliesOn).toBe('hot');
    expect(live.limits.preset).toBe('persistent');
    expect(lines.some((line) => line.level === 'error')).toBe(true);
    expect(await changed()).toHaveLength(1);
  });
});
