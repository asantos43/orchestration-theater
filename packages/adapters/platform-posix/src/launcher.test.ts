// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PROCESS_LAUNCHER_PORT_VERSION } from '@otheater/core';
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
