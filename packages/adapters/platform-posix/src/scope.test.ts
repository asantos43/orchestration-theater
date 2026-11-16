// SPDX-License-Identifier: MPL-2.0
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { describeProcessLauncherConformance } from '@otheater/sdk';
import { PosixProcessLauncher } from './index.js';
import {
  findSystemdRun,
  probeSystemdScope,
  resolveExecutable,
  scopeCommand,
} from './systemd-scope.js';

const MIB = 1024 * 1024;
const NODE = process.execPath;
const available = await probeSystemdScope();

describe.skipIf(findSystemdRun() === undefined || process.platform !== 'linux')(
  'scopeCommand (pure)',
  () => {
    it('doubles every dollar sign, because systemd-run expands them', () => {
      const command = scopeCommand(
        NODE,
        ['$HOME', '${X}', 'a$$b'],
        { PATH: '/usr/bin' },
        MIB,
        tmpdir(),
      );
      expect(command.args.slice(-3)).toEqual(['$$HOME', '$${X}', 'a$$$$b']);
    });

    it('asks for a hard ceiling with no swap', () => {
      const command = scopeCommand(NODE, [], {}, 64 * MIB, tmpdir());
      expect(command.args).toContain(`MemoryMax=${String(64 * MIB)}`);
      expect(command.args).toContain('MemorySwapMax=0');
    });
  },
);

// The PATH search is POSIX-only: it treats only `/` as a path separator.
describe.skipIf(process.platform === 'win32')('resolveExecutable', () => {
  it('finds a command on the PATH of the requested env, not of this process', () => {
    expect(resolveExecutable('node', { PATH: '/nonexistent' }, '/')).toBeUndefined();
    expect(resolveExecutable(NODE, {}, '/')).toBe(NODE);
  });

  it('ignores relative PATH entries and missing files', () => {
    expect(resolveExecutable('node', { PATH: 'bin:.' }, '/')).toBeUndefined();
    expect(
      resolveExecutable('definitely-not-a-command-xyz', { PATH: '/usr/bin:/bin' }, '/'),
    ).toBeUndefined();
  });
});

describe.skipIf(!available)('PosixProcessLauncher with memoryLimit systemd-scope', () => {
  // Built in beforeAll: Vitest still runs the body of a skipped describe, and the constructor
  // throws AdapterUnavailable where there is no systemd-run (Windows, macOS).
  let launcher: PosixProcessLauncher;
  beforeAll(() => {
    launcher = new PosixProcessLauncher({ memoryLimit: 'systemd-scope' });
  });

  const run = async (
    extra: Partial<LaunchOptions>,
    script: string,
  ): Promise<{ proc: LaunchedProcess; out: string }> => {
    const proc = await launcher.launch({
      cmd: NODE,
      args: ['-e', script],
      env: {},
      cwd: tmpdir(),
      memoryLimitBytes: 1024 * MIB,
      ...extra,
    });
    void proc.stderr.cancel().catch(() => undefined);
    const out = await new Response(proc.stdout).text();
    return { proc, out };
  };

  it('declares the memory limit capability', () => {
    expect(launcher.capabilities().memoryLimit).toBe(true);
  });

  it('enforces the ceiling: an allocation above it kills the process', async () => {
    const { proc } = await run(
      { memoryLimitBytes: 128 * MIB },
      'const b = Buffer.alloc(400 * 1024 * 1024, 1); process.stdout.write(String(b.length))',
    );
    try {
      const exit = await proc.exited;
      // The scope forks the command, so a kill by the kernel shows up as 128 + 9.
      expect(exit.code === 137 || exit.signal === 'SIGKILL').toBe(true);
    } finally {
      await proc.killTree({ graceMs: 0 });
    }
  }, 30_000);

  it('lets a process under the ceiling finish with its own exit code', async () => {
    const { proc, out } = await run({}, "process.stdout.write('ok'); process.exitCode = 3");
    try {
      expect(out).toBe('ok');
      expect((await proc.exited).code).toBe(3);
    } finally {
      await proc.killTree({ graceMs: 0 });
    }
  }, 30_000);

  it('hands the child exactly the requested env, without the systemd additions', async () => {
    const { proc, out } = await run(
      { env: { ONLY: '1' } },
      'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
    );
    try {
      expect(JSON.parse(out)).toEqual(['ONLY']);
    } finally {
      await proc.killTree({ graceMs: 0 });
    }
  }, 30_000);

  it('rejects a missing executable at launch with ADAPTER_UNAVAILABLE', async () => {
    await expect(
      launcher.launch({
        cmd: 'definitely-not-a-command-xyz',
        args: [],
        env: { PATH: '/usr/bin:/bin' },
        cwd: tmpdir(),
        memoryLimitBytes: 128 * MIB,
      }),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('ends a whole tree inside the scope', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(c.pid) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const proc = await launcher.launch({
      cmd: NODE,
      args: ['-e', script],
      env: {},
      cwd: tmpdir(),
      memoryLimitBytes: 1024 * MIB,
    });
    void proc.stderr.cancel().catch(() => undefined);
    let childPid = 0;
    try {
      const reader = proc.stdout.getReader();
      let text = '';
      while (!text.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      childPid = Number(text.trim());
      expect(childPid).toBeGreaterThan(1);
      const report = await proc.killTree({ graceMs: 500 });
      expect(report.remaining).toEqual([]);
      expect(report.found).toBeGreaterThanOrEqual(2);
      expect(() => process.kill(childPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }) as Error,
      );
    } finally {
      await proc.killTree({ graceMs: 0 });
      if (childPid > 1) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});

// The whole port contract once more, with a limit on every launch, so the scope wrapper is held
// to the same rules as the plain launcher. Skipped where systemd cannot make a scope.
describe.skipIf(!available)('conformance through a scope', () => {
  const inner = available ? new PosixProcessLauncher({ memoryLimit: 'systemd-scope' }) : undefined;
  const wrapped = (): ProcessLauncher => {
    if (inner === undefined) throw new Error('unreachable: skipped without systemd');
    return {
      id: inner.id,
      implements: inner.implements,
      capabilities: () => inner.capabilities(),
      launch: (opts) => inner.launch({ ...opts, memoryLimitBytes: 2048 * MIB }),
    };
  };
  describeProcessLauncherConformance('PosixProcessLauncher (systemd-scope)', () => ({
    launcher: wrapped(),
  }));
});
