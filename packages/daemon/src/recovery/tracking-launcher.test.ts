// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { LAUNCH_MARKER_ENV } from '@otheater/core';
import { FakeClock, FakeProcessLauncher, InMemoryStore } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { RecordingSituations } from '../test-helpers.js';
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

  it('recovery.notice process_not_tracked: a row that could not be written is an event, and the process still runs (P24, N146)', async () => {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const inner = new FakeProcessLauncher();
    const situations = new RecordingSituations();
    const failing = {
      sessions: {
        ...store.sessions,
        open: () => Promise.reject(new Error('disk full')),
      },
    } as unknown as ConstructorParameters<typeof TrackingLauncher>[1];
    const launcher = new TrackingLauncher(inner, failing, clock, createSilentLogger(), situations);
    const process = await launcher.launch({
      cmd: '/usr/bin/fake-agent',
      args: [],
      cwd: '/tmp',
      env: {},
    });
    expect(process.pid).toBe(inner.launched[0]?.pid);
    expect(situations.of('recovery.notice')).toEqual([
      { kind: 'process_not_tracked', subject: 'fake-agent', detail: 'disk full' },
    ]);
    const quiet = rig();
    const quietSituations = new RecordingSituations();
    await new TrackingLauncher(
      quiet.inner,
      quiet.store,
      clock,
      createSilentLogger(),
      quietSituations,
    ).launch({ cmd: 'fake-agent', args: [], cwd: '/tmp', env: {} });
    expect(quietSituations.recorded).toEqual([]);
  });

  it('writes the row before the process starts and hands its id to the child as the launch marker (Phase 11, P3)', async () => {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const inner = new FakeProcessLauncher();
    let rowsWhenLaunched = -1;
    const realLaunch = inner.launch.bind(inner);
    inner.launch = async (opts) => {
      rowsWhenLaunched = (await store.sessions.list({ states: ['active'] })).length;
      return realLaunch(opts);
    };
    const launcher = new TrackingLauncher(inner, store, clock, createSilentLogger());
    await launcher.launch({ cmd: 'fake-agent', args: [], cwd: '/tmp', env: { KEEP: '1' } });
    expect(rowsWhenLaunched).toBe(1);
    const [row] = await store.sessions.list({ states: ['active'] });
    expect(row?.id).toMatch(/^proc-/);
    const env = inner.launched[0]?.options.env;
    expect(env?.[LAUNCH_MARKER_ENV]).toBe(row?.id);
    expect(env?.KEEP).toBe('1');
  });

  it('closes the row of a launch that failed, so no live row names a process that never was', async () => {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const inner = new FakeProcessLauncher();
    inner.launch = () => Promise.reject(new Error('spawn failed'));
    const launcher = new TrackingLauncher(inner, store, clock, createSilentLogger());
    await expect(
      launcher.launch({ cmd: 'fake-agent', args: [], cwd: '/tmp', env: {} }),
    ).rejects.toThrow('spawn failed');
    expect(await store.sessions.list({ states: ['active'] })).toEqual([]);
    expect(await store.sessions.list({ states: ['closed'] })).toHaveLength(1);
  });

  it('keeps the identity and the capabilities of the launcher it wraps', () => {
    const { inner, launcher } = rig();
    expect(launcher.id).toBe(inner.id);
    expect(launcher.capabilities()).toEqual(inner.capabilities());
  });
});
