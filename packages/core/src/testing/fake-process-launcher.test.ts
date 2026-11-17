// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { supportsOrphanKill } from '../ports/process-launcher.js';
import { FakeProcessLauncher } from './fake-process-launcher.js';

describe('FakeProcessLauncher orphan capability', () => {
  it('is recognised as an orphan reaper', () => {
    expect(supportsOrphanKill(new FakeProcessLauncher())).toBe(true);
  });

  it('ends a planted orphan only when pid and start instant both match', async () => {
    const launcher = new FakeProcessLauncher();
    launcher.plantOrphan(31_337, 5_000);

    // A recycled pid: same pid, another start instant. Left alone.
    const recycled = await launcher.killOrphan({ pid: 31_337, startedAt: 9_000 });
    expect(recycled.matched).toBe(false);
    expect(launcher.orphanAlive(31_337)).toBe(true);

    const found = await launcher.killOrphan({ pid: 31_337, startedAt: 5_000 });
    expect(found.matched).toBe(true);
    expect(launcher.orphanAlive(31_337)).toBe(false);
    expect(launcher.orphanKills.map((kill) => kill.matched)).toEqual([false, true]);
  });

  it('knows nothing of a pid that is not there', async () => {
    const launcher = new FakeProcessLauncher();
    expect(await launcher.processStartedAt(1)).toBeUndefined();
    expect((await launcher.killOrphan({ pid: 1, startedAt: 1 })).matched).toBe(false);
  });

  it('reports the start instant of a process it launched, and can end it', async () => {
    const launcher = new FakeProcessLauncher();
    const process = await launcher.launch({ cmd: 'x', args: [], cwd: '/tmp', env: {} });
    const started = await launcher.processStartedAt(process.pid);
    expect(started).toBe(launcher.launched[0]?.startedAt);
    const result = await launcher.killOrphan({ pid: process.pid, startedAt: started ?? 0 });
    expect(result.matched).toBe(true);
    expect(launcher.running).toHaveLength(0);
  });
});
