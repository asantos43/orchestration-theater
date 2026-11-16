// SPDX-License-Identifier: MPL-2.0
import { describe, expect, expectTypeOf, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';
import {
  assertLaunchOptions,
  DEFAULT_KILL_GRACE_MS,
  PROCESS_LAUNCHER_PORT_VERSION,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessLauncher,
} from './process-launcher.js';

const base: LaunchOptions = { cmd: 'node', args: ['-v'], cwd: '/work', env: { PATH: '/bin' } };

describe('ProcessLauncher contract', () => {
  it('is versioned and is an Adapter', () => {
    expect(PROCESS_LAUNCHER_PORT_VERSION).toBe('0.1.0');
    expect(DEFAULT_KILL_GRACE_MS).toBe(5000);
    expectTypeOf<ProcessLauncher>().toExtend<Adapter>();
    expectTypeOf<ProcessLauncher['launch']>().returns.resolves.toEqualTypeOf<LaunchedProcess>();
    expectTypeOf<LaunchedProcess['stdout']>().toEqualTypeOf<ReadableStream<Uint8Array>>();
  });
});

describe('assertLaunchOptions', () => {
  it('accepts posix and Windows absolute paths and a full environment', () => {
    expect(() => {
      assertLaunchOptions(base);
    }).not.toThrow();
    expect(() => {
      assertLaunchOptions({ ...base, cwd: 'C:\\work', memoryLimitBytes: 1024 });
    }).not.toThrow();
    expect(() => {
      assertLaunchOptions({ ...base, cwd: '\\\\server\\share' });
    }).not.toThrow();
  });

  it('refuses bad options with InvalidInput', () => {
    const bad: LaunchOptions[] = [
      { ...base, cmd: '' },
      { ...base, cmd: 'a\0b' },
      { ...base, args: ['ok', 'a\0'] },
      { ...base, cwd: 'relative/dir' },
      { ...base, cwd: '' },
      { ...base, env: { 'A=B': 'x' } },
      { ...base, env: { '': 'x' } },
      { ...base, env: { A: 'x\0' } },
      { ...base, memoryLimitBytes: 0 },
      { ...base, memoryLimitBytes: 1.5 },
    ];
    for (const opts of bad) {
      expect(() => {
        assertLaunchOptions(opts);
      }, JSON.stringify(opts)).toThrow(InvalidInput);
    }
  });
});
