// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  LAUNCH_MARKER_ENV,
  PROCESS_LAUNCHER_PORT_VERSION,
  supportsMarkerScan,
  supportsOrphanKill,
} from '@otheater/core';
import { describeProcessLauncherConformance } from '@otheater/sdk';
import { PosixProcessLauncher } from './index.js';

// Signals, process groups and POSIX env semantics: on Windows the daemon will use the Windows
// adapter (arquitetura 5.9) and this launcher is not supported there. Where it was tried, the
// suite failed on the signal report, the extra variables Windows adds to the child env and
// killTree finding nothing, which says "unsupported", not "bug in the suite".
describe.skipIf(process.platform === 'win32')('PosixProcessLauncher conformance', () => {
  describeProcessLauncherConformance('PosixProcessLauncher', () => ({
    launcher: new PosixProcessLauncher(),
  }));
});

describe('PosixProcessLauncher', () => {
  it('declares the process-group tree kill and no memory limit by default', () => {
    const launcher = new PosixProcessLauncher();
    expect(launcher.id).toBe('posix');
    expect(launcher.implements).toEqual({
      port: 'ProcessLauncher',
      range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
    });
    expect(launcher.capabilities()).toEqual({
      treeKill: 'process-group',
      memoryLimit: false,
      suspendedStart: false,
    });
  });

  it('rejects an unknown config key or memoryLimit mode', () => {
    expect(() => new PosixProcessLauncher({ memoryLimit: 'cgroup' as 'none' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
    expect(() => new PosixProcessLauncher({ nope: 1 } as object)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
  });
});

describe.skipIf(process.platform !== 'linux')('PosixProcessLauncher orphan capability', () => {
  const launchSleeper = async (launcher: PosixProcessLauncher) =>
    launcher.launch({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: process.cwd(),
      env: {},
    });

  it('is recognised as an orphan reaper', () => {
    expect(supportsOrphanKill(new PosixProcessLauncher())).toBe(true);
  });

  it('knows nothing of a pid that is not there', async () => {
    const launcher = new PosixProcessLauncher();
    expect(await launcher.processStartedAt(2 ** 22 + 12345)).toBeUndefined();
    expect((await launcher.killOrphan({ pid: 2 ** 22 + 12345, startedAt: 1 })).matched).toBe(false);
  });

  it('never signals a pid whose start instant is not the recorded one (a recycled pid)', async () => {
    const launcher = new PosixProcessLauncher();
    const process_ = await launchSleeper(launcher);
    try {
      const started = await launcher.processStartedAt(process_.pid);
      expect(started).toBeGreaterThan(0);
      const result = await launcher.killOrphan({
        pid: process_.pid,
        startedAt: (started ?? 0) - 60_000,
      });
      expect(result.matched).toBe(false);
      expect(await launcher.processStartedAt(process_.pid)).toBeDefined();
    } finally {
      await process_.killTree();
    }
  });

  it('ends the tree of the process that was recorded', async () => {
    const launcher = new PosixProcessLauncher();
    const process_ = await launchSleeper(launcher);
    const started = await launcher.processStartedAt(process_.pid);
    const result = await launcher.killOrphan({ pid: process_.pid, startedAt: started ?? 0 });
    expect(result.matched).toBe(true);
    expect(result.report.found).toBeGreaterThanOrEqual(1);
    await process_.exited;
    expect(await launcher.processStartedAt(process_.pid)).toBeUndefined();
  });

  it('finds the live process that carries a launch marker, and only that one (Phase 11, P3)', async () => {
    const launcher = new PosixProcessLauncher();
    expect(supportsMarkerScan(launcher)).toBe(true);
    const marker = `test-marker-${String(process.pid)}-${String(Date.now())}`;
    const marked = await launcher.launch({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: process.cwd(),
      env: { [LAUNCH_MARKER_ENV]: marker },
    });
    const plain = await launchSleeper(launcher);
    try {
      const found = (await launcher.findMarked()).filter((entry) => entry.marker === marker);
      expect(found.map((entry) => entry.pid)).toEqual([marked.pid]);
      const started = await launcher.processStartedAt(marked.pid);
      expect(Math.abs((found[0]?.startedAt ?? 0) - (started ?? -1))).toBeLessThan(2000);
      expect((await launcher.findMarked()).some((entry) => entry.pid === plain.pid)).toBe(false);
    } finally {
      await marked.killTree();
      await plain.killTree();
    }
    expect((await launcher.findMarked()).some((entry) => entry.marker === marker)).toBe(false);
  });
});
