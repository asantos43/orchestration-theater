// SPDX-License-Identifier: MPL-2.0
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PROCESS_LAUNCHER_PORT_VERSION } from '@otheater/core';
import { describeProcessLauncherConformance } from '@otheater/sdk';
import {
  launcherArguments,
  launcherFailureOf,
  WindowsProcessLauncher,
  type WindowsLauncherDeps,
} from './launcher.js';
import { checkoutRoots, locateJobLauncher } from './locate.js';

const LAUNCHER = 'C:\\ot\\ot-job-launcher.exe';
/** The pid the fake launcher is tied to. */
const PARENT = 777;
const TIED = ['--parent-pid', '777'];

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

/** A child process that only does what a test tells it to. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  killed = 0;
  /** What `kill()` does; the default ends the child at once, as TerminateProcess does. */
  onKill: () => void = () => {
    this.end(1);
  };

  kill(): boolean {
    this.killed += 1;
    this.onKill();
    return true;
  }

  end(code: number | null): void {
    this.emit('exit', code, null);
  }
}

function build(overrides: Partial<WindowsLauncherDeps> = {}) {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const deps: WindowsLauncherDeps = {
    platform: 'win32',
    parentPid: PARENT,
    exists: () => true,
    isFile: (path) => path.toLowerCase() === 'c:\\bin\\agent.exe',
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    },
    ...overrides,
  };
  return {
    launcher: new WindowsProcessLauncher({ launcherPath: LAUNCHER }, deps),
    calls,
    children,
  };
}

const options = {
  cmd: 'C:\\bin\\agent.exe',
  args: ['--flag', 'a b'],
  cwd: 'C:\\work',
  env: { PATH: 'C:\\bin', FOO: 'bar' },
};

describe('launcherArguments', () => {
  it('puts the Executor after the first --, untouched', () => {
    expect(launcherArguments('C:\\bin\\a.exe', ['--', '-x', 'a b', ''])).toEqual([
      '--',
      'C:\\bin\\a.exe',
      '--',
      '-x',
      'a b',
      '',
    ]);
  });

  it('adds the memory limit before the --', () => {
    expect(launcherArguments('C:\\bin\\a.exe', [], { memoryLimitBytes: 1048576 })).toEqual([
      '--memory-limit-bytes',
      '1048576',
      '--',
      'C:\\bin\\a.exe',
    ]);
  });

  it('adds the parent pid before the --, after the memory limit', () => {
    expect(
      launcherArguments('C:\\bin\\a.exe', ['x'], { memoryLimitBytes: 5, parentPid: 123 }),
    ).toEqual(['--memory-limit-bytes', '5', '--parent-pid', '123', '--', 'C:\\bin\\a.exe', 'x']);
  });
});

describe('launcherFailureOf', () => {
  it('names the codes of the launcher itself and nothing else', () => {
    expect(launcherFailureOf(0x4f540007)).toMatch(/\.cmd or \.bat/);
    expect(launcherFailureOf(0x4f540003)).toMatch(/could not be started/);
    expect(launcherFailureOf(0x4f540008)).toMatch(/parent/);
    expect(launcherFailureOf(0x4f540009)).toMatch(/parent process ended/);
    expect(launcherFailureOf(0)).toBeUndefined();
    expect(launcherFailureOf(1)).toBeUndefined();
    expect(launcherFailureOf(null)).toBeUndefined();
  });

  it('reads a negative (signed) exit code as the unsigned one', () => {
    expect(launcherFailureOf(0x4f540002 | 0)).toMatch(/job/);
  });
});

describe('WindowsProcessLauncher (fake spawn, platform win32)', () => {
  it('declares the Job Object capabilities and the port', () => {
    const { launcher } = build();
    expect(launcher.id).toBe('windows');
    expect(launcher.implements).toEqual({
      port: 'ProcessLauncher',
      range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
    });
    expect(launcher.capabilities()).toEqual({
      treeKill: 'job-object',
      memoryLimit: true,
      suspendedStart: true,
    });
  });

  it('starts the launcher with the exact env, cwd, a hidden window and the Executor after --', async () => {
    const { launcher, calls } = build();
    const proc = await launcher.launch(options);
    expect(proc.pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(LAUNCHER);
    expect(calls[0]?.args).toEqual([...TIED, '--', 'C:\\bin\\agent.exe', '--flag', 'a b']);
    expect(calls[0]?.options).toMatchObject({
      cwd: 'C:\\work',
      env: { PATH: 'C:\\bin', FOO: 'bar' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('resolves a bare command in the PATH of the child before starting the launcher', async () => {
    const { launcher, calls } = build();
    await launcher.launch({ ...options, cmd: 'agent' });
    expect(calls[0]?.args.slice(0, 4)).toEqual([...TIED, '--', 'C:\\bin\\agent.exe']);
  });

  it('passes the memory limit of the role policy as --memory-limit-bytes', async () => {
    const { launcher, calls } = build();
    await launcher.launch({ ...options, memoryLimitBytes: 536870912 });
    expect(calls[0]?.args).toEqual([
      '--memory-limit-bytes',
      '536870912',
      ...TIED,
      '--',
      'C:\\bin\\agent.exe',
      '--flag',
      'a b',
    ]);
  });

  it('refuses .cmd and .bat and what does not resolve, without starting anything', async () => {
    const { launcher, calls } = build({ isFile: (path) => path.endsWith('codex.cmd') });
    for (const cmd of ['C:\\npm\\codex.cmd', 'setup.bat', 'codex', 'ghost']) {
      await expect(launcher.launch({ ...options, cmd })).rejects.toMatchObject({
        code: 'ADAPTER_UNAVAILABLE',
      });
    }
    expect(calls).toEqual([]);
  });

  it('ties the launcher to the pid of this process unless told otherwise', async () => {
    const calls: string[][] = [];
    const launcher = new WindowsProcessLauncher(
      { launcherPath: LAUNCHER },
      {
        platform: 'win32',
        exists: () => true,
        isFile: () => true,
        spawn: (_file, args) => {
          calls.push([...args]);
          const child = new FakeChild();
          queueMicrotask(() => child.emit('spawn'));
          return child as unknown as ChildProcess;
        },
      },
    );
    await launcher.launch(options);
    expect(calls[0]?.slice(0, 2)).toEqual(['--parent-pid', String(process.pid)]);
  });

  it('rejects invalid launch options with INVALID_INPUT', async () => {
    const { launcher } = build();
    await expect(launcher.launch({ ...options, cwd: '' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  describe('npm shims (.cmd)', () => {
    const shim = 'C:\\npm\\codex-acp.cmd';
    const script = 'C:\\npm\\node_modules\\@x\\codex-acp\\bin\\codex-acp.js';
    const shimText = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@x\\codex-acp\\bin\\codex-acp.js" %*',
    ].join('\r\n');
    const files = new Set([shim, script, 'C:\\nodejs\\node.exe'].map((p) => p.toLowerCase()));
    const shimDeps = {
      isFile: (path: string) => files.has(path.toLowerCase()),
      readFile: () => shimText,
    };
    const shimOptions = {
      ...options,
      cmd: 'codex-acp',
      env: { PATH: 'C:\\npm;C:\\nodejs' },
    };

    it('runs node.exe with the script of the shim, and the arguments after it', async () => {
      const { launcher, calls } = build(shimDeps);
      await launcher.launch(shimOptions);
      expect(calls[0]?.args).toEqual([
        ...TIED,
        '--',
        'C:\\nodejs\\node.exe',
        script,
        '--flag',
        'a b',
      ]);
    });

    it('refuses a .bat even when shims are resolved', async () => {
      const { launcher, calls } = build({ ...shimDeps, isFile: () => true });
      await expect(launcher.launch({ ...options, cmd: 'C:\\x\\setup.bat' })).rejects.toThrow(
        /setup\.bat/,
      );
      expect(calls).toEqual([]);
    });

    it('refuses a shim that is not in the format, naming the path', async () => {
      const { launcher, calls } = build({
        ...shimDeps,
        readFile: () => '@echo off\r\ncodex.exe %*',
      });
      await expect(launcher.launch(shimOptions)).rejects.toThrow(/codex-acp\.cmd/);
      expect(calls).toEqual([]);
    });

    it('with windows_shims = refuse reads nothing and refuses the shim', async () => {
      const readFile = vi.fn(() => shimText);
      const calls: unknown[] = [];
      const launcher = new WindowsProcessLauncher(
        { launcherPath: LAUNCHER, shims: 'refuse' },
        {
          platform: 'win32',
          exists: () => true,
          ...shimDeps,
          readFile,
          spawn: (...args) => {
            calls.push(args);
            throw new Error('must not start');
          },
        },
      );
      await expect(launcher.launch(shimOptions)).rejects.toMatchObject({
        code: 'ADAPTER_UNAVAILABLE',
      });
      expect(readFile).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  });

  it('maps a spawn error to ADAPTER_UNAVAILABLE', async () => {
    const { launcher } = build({
      spawn: () => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
        return child as unknown as ChildProcess;
      },
    });
    await expect(launcher.launch(options)).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('reports the exit of the launcher, which carries the code of the Executor', async () => {
    const { launcher, children } = build();
    const proc = await launcher.launch(options);
    children[0]?.end(7);
    expect(await proc.exited).toEqual({ code: 7, signal: null });
  });

  it('killTree terminates the launcher once and reports it', async () => {
    const { launcher, children } = build();
    const proc = await launcher.launch(options);
    const [first, second] = await Promise.all([proc.killTree(), proc.killTree({ graceMs: 5 })]);
    expect(first).toEqual({ found: 1, forced: true, remaining: [] });
    expect(second).toEqual(first);
    expect(children[0]?.killed).toBe(1);
    // Settled: nothing left to end.
    expect(await proc.killTree()).toEqual({ found: 0, forced: false, remaining: [] });
    expect(children[0]?.killed).toBe(1);
  });

  it('killTree after the launcher ended on its own does not kill anything', async () => {
    const { launcher, children } = build();
    const proc = await launcher.launch(options);
    children[0]?.end(0);
    await proc.exited;
    expect(await proc.killTree()).toEqual({ found: 0, forced: false, remaining: [] });
    expect(children[0]?.killed).toBe(0);
  });

  it('killTree waits for the launcher to end after terminating it', async () => {
    const { launcher, children } = build();
    const proc = await launcher.launch(options);
    const child = children[0];
    if (child === undefined) throw new Error('no child');
    child.onKill = () => undefined;
    const kill = proc.killTree();
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.end(1);
    // Ended within the wait, so nothing remains.
    expect(await kill).toEqual({ found: 1, forced: true, remaining: [] });
  });

  it('killTree rejects a negative or non-finite graceMs with INVALID_INPUT', async () => {
    const { launcher } = build();
    const proc = await launcher.launch(options);
    for (const graceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(proc.killTree({ graceMs })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('does not exist anywhere but on Windows, nor without an absolute launcher path or file', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        () =>
          new WindowsProcessLauncher({ launcherPath: LAUNCHER }, { platform, exists: () => true }),
      ).toThrow(expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error);
    }
    expect(
      () =>
        new WindowsProcessLauncher({ launcherPath: 'ot-job-launcher.exe' }, { platform: 'win32' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }) as Error);
    expect(
      () =>
        new WindowsProcessLauncher(
          { launcherPath: LAUNCHER },
          { platform: 'win32', exists: () => false },
        ),
    ).toThrow(expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error);
    expect(() => new WindowsProcessLauncher({} as never, { platform: 'win32' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
  });
});

// The real tests: Windows, with `ot-job-launcher.exe` built (`cargo build --locked` in
// `native/job-launcher`, which the `windows-launcher` job of the CI does before this file runs).
// Everywhere else they are skipped, as they are in the `cross` job, which does not build it.
const found = locateJobLauncher({
  execPath: process.execPath,
  checkoutRoots: checkoutRoots(),
  exists: existsSync,
});
const launcherPath = found.found ? found.path : undefined;
const realEnabled = process.platform === 'win32' && launcherPath !== undefined;
const fakeAgent = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

describe.skipIf(!realEnabled)('WindowsProcessLauncher with the real ot-job-launcher.exe', () => {
  const real = () => new WindowsProcessLauncher({ launcherPath: launcherPath ?? '' });

  describeProcessLauncherConformance('WindowsProcessLauncher', () => ({ launcher: real() }));

  it('runs the fake ACP agent through the launcher and ends its tree on killTree', async () => {
    const launcher = real();
    const proc = await launcher.launch({
      cmd: process.execPath,
      args: [fakeAgent],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    try {
      const writer = proc.stdin.getWriter();
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      };
      await writer.write(new TextEncoder().encode(`${JSON.stringify(request)}\n`));
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const line = new TextDecoder().decode(value).split('\n')[0] ?? '';
      expect(JSON.parse(line)).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
      reader.releaseLock();
    } finally {
      const report = await proc.killTree();
      expect(report.remaining).toEqual([]);
    }
    expect((await proc.exited).signal).toBeNull();
  });

  it('ends a grandchild when the launcher itself is terminated (KILL_ON_JOB_CLOSE)', async () => {
    const launcher = real();
    const script =
      'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});' +
      'process.stdout.write(String(c.pid)+"\\n");setInterval(()=>{},1000)';
    const proc = await launcher.launch({
      cmd: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const grandchild = Number.parseInt(new TextDecoder().decode(value).trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(grandchild)).toBe(true);
    // Only the launcher is touched; the job does the rest.
    spawnSync('taskkill', ['/PID', String(proc.pid), '/F'], { windowsHide: true });
    await proc.exited;
    const deadline = Date.now() + 5000;
    while (alive(grandchild) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(grandchild)).toBe(false);
  });

  it('ends the child and the grandchild when the process that started the launcher is killed', async () => {
    // The intermediary plays the daemon: it starts the launcher through the adapter (which passes
    // --parent-pid of its own pid) and is then killed at once, with no chance to clean anything.
    const dir = mkdtempSync(join(tmpdir(), 'ot-parent-'));
    const pidsFile = join(dir, 'pids.txt');
    const intermediary = join(dir, 'daemon.mjs');
    const adapter = pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href;
    const grandchild = 'setInterval(()=>{},1000)';
    const child =
      'const c=require("node:child_process").spawn(process.execPath,["-e",' +
      JSON.stringify(grandchild) +
      '],{stdio:"ignore"});' +
      'require("node:fs").writeFileSync(process.env.OT_PIDS,process.pid+" "+c.pid);' +
      'setInterval(()=>{},1000)';
    writeFileSync(
      intermediary,
      [
        `import { WindowsProcessLauncher } from ${JSON.stringify(adapter)};`,
        `const launcher = new WindowsProcessLauncher({ launcherPath: ${JSON.stringify(launcherPath)} });`,
        'await launcher.launch({',
        '  cmd: process.execPath,',
        `  args: ['-e', ${JSON.stringify(child)}],`,
        '  cwd: process.cwd(),',
        '  env: { ...process.env },',
        '});',
        'console.log("ready");',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const daemon = spawn(process.execPath, [intermediary], {
      env: { ...process.env, OT_PIDS: pidsFile },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let pids: number[] = [];
    try {
      await vi.waitFor(
        () => {
          pids = readFileSync(pidsFile, 'utf8')
            .trim()
            .split(' ')
            .map((n) => Number.parseInt(n, 10));
          expect(pids).toHaveLength(2);
          expect(pids.every((pid) => alive(pid))).toBe(true);
        },
        { timeout: 20000, interval: 100 },
      );
      // By force, as a crash or an end-task would: nothing of the daemon runs.
      spawnSync('taskkill', ['/PID', String(daemon.pid), '/F'], { windowsHide: true });
      await vi.waitFor(
        () => {
          expect(pids.map((pid) => alive(pid))).toEqual([false, false]);
        },
        { timeout: 30000, interval: 200 },
      );
    } finally {
      for (const pid of [daemon.pid, ...pids]) {
        if (pid !== undefined)
          spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70000);

  it('refuses a .cmd script before the launcher is started', async () => {
    await expect(
      real().launch({ cmd: 'C:\\x\\codex.cmd', args: [], cwd: process.cwd(), env: {} }),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });
});
