// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PROCESS_LAUNCHER_PORT_VERSION } from '@otheater/core';
import { describeProcessLauncherConformance } from '@otheater/sdk';
import { PosixProcessLauncher } from './index.js';

describeProcessLauncherConformance('PosixProcessLauncher', () => ({
  launcher: new PosixProcessLauncher(),
}));

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
