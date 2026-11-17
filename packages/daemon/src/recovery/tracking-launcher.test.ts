// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { FakeClock, FakeProcessLauncher, InMemoryStore } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { TRACKED_PROFILE, TrackingLauncher } from './tracking-launcher.js';

function rig() {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const inner = new FakeProcessLauncher();
  const launcher = new TrackingLauncher(inner, store, clock, createSilentLogger());
  return { store, inner, launcher };
}

describe('TrackingLauncher', () => {
  it('writes the pid and the start instant of each process before handing it over', async () => {
    const { store, inner, launcher } = rig();
    const process = await launcher.launch({
      cmd: '/usr/bin/fake-agent',
      args: [],
      cwd: '/tmp',
      env: {},
    });
    const rows = await store.sessions.list({ states: ['active'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: process.pid,
      processStartedAt: inner.launched[0]?.startedAt,
      client: 'fake-agent',
      profile: TRACKED_PROFILE,
      state: 'active',
    });
  });

  it('closes the row when the process ends', async () => {
    const { store, inner, launcher } = rig();
    await launcher.launch({ cmd: 'fake-agent', args: [], cwd: '/tmp', env: {} });
    await inner.launched[0]?.killTree();
    await inner.launched[0]?.exited;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.sessions.list({ states: ['active'] })).toEqual([]);
    expect(await store.sessions.list({ states: ['closed'] })).toHaveLength(1);
  });

  it('keeps the identity and the capabilities of the launcher it wraps', () => {
    const { inner, launcher } = rig();
    expect(launcher.id).toBe(inner.id);
    expect(launcher.capabilities()).toEqual(inner.capabilities());
  });
});
