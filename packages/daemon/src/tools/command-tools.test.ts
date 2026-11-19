// SPDX-License-Identifier: MPL-2.0
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRefusal } from './context.js';
import {
  eventsOf,
  makeToolsRig,
  realClock,
  type ToolsRig,
  type ToolsRigOptions,
} from './tools-fixture.js';
import { InMemoryStore } from '@otheater/core/testing';
import type { ProcessLauncher } from '@otheater/core';
import { defaultLauncher } from '../compose.js';
import { describeWithLauncher, itWithLauncher } from '../launcher-fixture.js';

const rigs: ToolsRig[] = [];

async function rigOf(options: ToolsRigOptions = {}): Promise<ToolsRig> {
  const rig = await makeToolsRig(options, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

const NODE = 'node';

describe('restricted_shell in the mode list (the default)', () => {
  itWithLauncher('runs an allowed command in the worktree and answers its output', async () => {
    const rig = await rigOf();
    const reply = await rig.call('restricted_shell', { argv: ['ls'] });
    expect(reply).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect((reply as { stdout: string }).stdout).toContain('README.md');
  });

  itWithLauncher('answers a non-zero exit as a normal result, with the stderr', async () => {
    const rig = await rigOf();
    const reply = await rig.call('restricted_shell', { argv: ['cat', 'missing.txt'] });
    expect(reply).toMatchObject({ timedOut: false });
    expect((reply as { exitCode: number }).exitCode).not.toBe(0);
    expect((reply as { stderr: string }).stderr).toContain('missing.txt');
    const finished = eventsOf(rig, 'tool.finished');
    expect(finished[0]?.payload).toMatchObject({ outcome: 'failed' });
  });

  it('refuses what is not in the list, with a stable code and no process', async () => {
    const rig = await rigOf();
    for (const argv of [
      ['rm', '-rf', 'x'],
      ['git', 'push'],
      ['git', 'commit', '-m', 'x'],
      ['sh'],
    ]) {
      const failure = await rig.fail('restricted_shell', { argv });
      expect(failure).toBeInstanceOf(ToolRefusal);
      expect(failure.code).toBe('program_not_allowed');
    }
    const finished = eventsOf(rig, 'tool.finished');
    expect(finished).toHaveLength(4);
    expect(
      finished.every((event) => (event.payload as { outcome: string }).outcome === 'refused'),
    ).toBe(true);
  });

  it('refuses a program given by path, shell syntax and an option that writes', async () => {
    const rig = await rigOf();
    expect((await rig.fail('restricted_shell', { argv: ['/bin/ls'] })).code).toBe(
      'program_by_path',
    );
    expect((await rig.fail('restricted_shell', { argv: ['ls', ';', 'rm', 'x'] })).code).toBe(
      'shell_syntax',
    );
    expect((await rig.fail('restricted_shell', { argv: ['ls', '$HOME'] })).code).toBe(
      'shell_syntax',
    );
    expect((await rig.fail('restricted_shell', { argv: ['git', 'diff', '--output=x'] })).code).toBe(
      'forbidden_flag',
    );
  });

  itWithLauncher('keeps every path argument inside the worktree, symlinks included', async () => {
    const rig = await rigOf();
    expect((await rig.fail('restricted_shell', { argv: ['cat', '/etc/passwd'] })).code).toBe(
      'path_escapes',
    );
    expect((await rig.fail('restricted_shell', { argv: ['cat', '../outside'] })).code).toBe(
      'path_escapes',
    );
    await symlink('/etc', join(rig.worktree, 'etc-link'));
    expect((await rig.fail('restricted_shell', { argv: ['ls', 'etc-link'] })).code).toBe(
      'symlink_escapes',
    );
    // A path inside, by name and by absolute path, is fine.
    await mkdir(join(rig.worktree, 'sub'));
    await rig.write('sub/a.txt', 'inside\n');
    for (const path of ['sub/a.txt', join(rig.worktree, 'sub/a.txt')]) {
      expect(await rig.call('restricted_shell', { argv: ['cat', path] })).toMatchObject({
        exitCode: 0,
        stdout: 'inside\n',
      });
    }
  });

  it('answers no_worktree for a session that has none', async () => {
    const rig = await rigOf();
    const failure = await rig.fail('restricted_shell', { argv: ['ls'] }, { worktree: undefined });
    expect(failure.code).toBe('no_worktree');
  });

  it('answers unavailable on a platform with no launcher, after the rules', async () => {
    const rig = await rigOf({ launcher: undefined });
    expect((await rig.fail('restricted_shell', { argv: ['ls'] })).code).toBe('unavailable');
    // A refused call keeps its own code there too: the rules do not need a process.
    const refused = await rig.fail('restricted_shell', { argv: ['git', 'push'] });
    expect(refused).toBeInstanceOf(ToolRefusal);
    expect(refused.code).toBe('program_not_allowed');
    expect((await rig.fail('run_tests', {})).code).toBe('no_command');
  });
});

describe('restricted_shell in the other modes', () => {
  itWithLauncher(
    'any lets a program of the PATH run, and still applies the argv rules',
    async () => {
      const rig = await rigOf({ tools: '  shell_allowlist:\n    mode: any' });
      await rig.write('hello.js', "process.stdout.write('hello')");
      expect(await rig.call('restricted_shell', { argv: ['wc', '-c', 'hello.js'] })).toMatchObject({
        exitCode: 0,
      });
      expect((await rig.fail('restricted_shell', { argv: ['wc', '/etc/passwd'] })).code).toBe(
        'path_escapes',
      );
      expect((await rig.fail('restricted_shell', { argv: ['ls', '&&', 'ls'] })).code).toBe(
        'shell_syntax',
      );
      expect((await rig.fail('restricted_shell', { argv: ['rg', '--pre=x', 'a'] })).code).toBe(
        'forbidden_flag',
      );
    },
  );

  itWithLauncher('profile lets only the commands of the project conventions run', async () => {
    const rig = await rigOf({
      tools: '  shell_allowlist:\n    mode: profile',
      conventions: { commands: { lint: 'ls -a', test: ['cat', 'README.md'] } },
    });
    expect(await rig.call('restricted_shell', { argv: ['ls', '-a'] })).toMatchObject({
      exitCode: 0,
    });
    expect(await rig.call('restricted_shell', { argv: ['cat', 'README.md'] })).toMatchObject({
      exitCode: 0,
    });
    // `ls` alone is not the command of the project, and `rg` is not in it at all.
    expect((await rig.fail('restricted_shell', { argv: ['rg', 'hello'] })).code).toBe(
      'program_not_allowed',
    );
  });

  it('profile with no conventions lets nothing run', async () => {
    const rig = await rigOf({ tools: '  shell_allowlist:\n    mode: profile' });
    expect((await rig.fail('restricted_shell', { argv: ['ls'] })).code).toBe('program_not_allowed');
  });

  itWithLauncher('the scenario overrides the mode and the list of the project', async () => {
    const rig = await rigOf({
      tools: '  shell_allowlist:\n    list: [ls]',
      configOverride: { 'tools.shell_allowlist.list': ['cat'] },
    });
    expect((await rig.fail('restricted_shell', { argv: ['ls'] })).code).toBe('program_not_allowed');
    expect(await rig.call('restricted_shell', { argv: ['cat', 'README.md'] })).toMatchObject({
      exitCode: 0,
    });
  });
});

describe('run_tests and install_deps', () => {
  itWithLauncher('take the command from the project, never from the model', async () => {
    const rig = await rigOf({
      tools: '  commands:\n    test: [cat, README.md]\n    install: [ls, -a]',
    });
    expect(await rig.call('run_tests', {})).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
    expect(await rig.call('install_deps', {})).toMatchObject({ exitCode: 0 });
    // The input has no room for a command.
    await expect(rig.call('run_tests', { command: ['rm', '-rf', '.'] })).rejects.toThrow();
  });

  itWithLauncher(
    'prefer the override of the scenario, then the conventions, then the global config',
    async () => {
      const global = '  commands:\n    test: [echo, global]';
      const conventions = { commands: { test: ['echo', 'conventions'] } };
      const globalOnly = await rigOf({ tools: global });
      expect(await globalOnly.call('run_tests', {})).toMatchObject({ stdout: 'global\n' });
      const withConventions = await rigOf({ tools: global, conventions });
      expect(await withConventions.call('run_tests', {})).toMatchObject({
        stdout: 'conventions\n',
      });
      const overridden = await rigOf({
        tools: global,
        conventions,
        configOverride: { tools: { commands: { test: 'echo scenario' } } },
      });
      expect(await overridden.call('run_tests', {})).toMatchObject({ stdout: 'scenario\n' });
    },
  );

  it('answer no_command when nothing names the command', async () => {
    const rig = await rigOf();
    expect((await rig.fail('run_tests', {})).code).toBe('no_command');
    expect((await rig.fail('install_deps', {})).code).toBe('no_command');
  });

  it('refuse a configured command that is not a plain argv', async () => {
    const rig = await rigOf({ tools: '  commands:\n    test: /bin/echo hi' });
    expect((await rig.fail('run_tests', {})).code).toBe('invalid_command');
  });

  itWithLauncher(
    'append the target of run_tests as one argument, inside the worktree',
    async () => {
      const rig = await rigOf({ tools: '  commands:\n    test: [cat]' });
      await rig.write('t.txt', 'target\n');
      expect(await rig.call('run_tests', { target: 't.txt' })).toMatchObject({
        stdout: 'target\n',
      });
      expect((await rig.fail('run_tests', { target: '../x' })).code).toBe('path_escapes');
      expect((await rig.fail('run_tests', { target: '--version' })).code).toBe('forbidden_flag');
    },
  );

  it('refuse an override of the scenario that does not validate, and never widen', async () => {
    const rig = await rigOf({ configOverride: { tools: { timeout_ms: 'soon' } } });
    expect((await rig.fail('restricted_shell', { argv: ['ls'] })).code).toBe('invalid_config');
    const unknown = await rigOf({ configOverride: { 'tools.env_inherit': 'all' } });
    expect((await unknown.fail('restricted_shell', { argv: ['ls'] })).code).toBe('invalid_config');
  });
});

describeWithLauncher('timeout and truncation (N98)', () => {
  it('ends a command that runs out of time and answers timedOut', async () => {
    const rig = await rigOf({
      tools: '  timeout_ms: 400\n  shell_allowlist:\n    mode: any',
    });
    await rig.write('hang.js', 'setTimeout(() => {}, 60_000); console.log("started");');
    const started = Date.now();
    const reply = await rig.call('restricted_shell', { argv: [NODE, 'hang.js'] });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(reply).toMatchObject({ exitCode: null, timedOut: true });
    expect((reply as { stdout: string }).stdout).toContain('started');
    expect(eventsOf(rig, 'tool.finished')[0]?.payload).toMatchObject({ outcome: 'timed_out' });
  }, 30_000);

  it('ends the whole tree: a child that keeps the pipe open does not hold the call', async () => {
    const rig = await rigOf({
      tools: '  timeout_ms: 400\n  shell_allowlist:\n    mode: any',
    });
    await rig.write(
      'tree.js',
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
        'setTimeout(() => {}, 60_000);',
      ].join('\n'),
    );
    const started = Date.now();
    const reply = await rig.call('restricted_shell', { argv: [NODE, 'tree.js'] });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(reply).toMatchObject({ timedOut: true });
  }, 30_000);

  it('cuts a long output to output_max_bytes and says so', async () => {
    const rig = await rigOf({
      tools: '  output_max_bytes: 200\n  shell_allowlist:\n    mode: any',
    });
    await rig.write('big.js', "process.stdout.write('x'.repeat(5000) + 'END');");
    const reply = (await rig.call('restricted_shell', { argv: [NODE, 'big.js'] })) as {
      stdout: string;
      stdoutBytes: number;
      truncated: boolean;
    };
    expect(reply.truncated).toBe(true);
    expect(reply.stdoutBytes).toBe(5003);
    expect(Buffer.byteLength(reply.stdout)).toBeLessThan(600);
    expect(reply.stdout).toContain('END');
    expect(eventsOf(rig, 'tool.finished')[0]?.payload).toMatchObject({
      truncated: true,
      outputBytes: 5003,
    });
  });

  it('keeps the beginning with truncate: head', async () => {
    const rig = await rigOf({
      tools: '  output_max_bytes: 100\n  truncate: head\n  shell_allowlist:\n    mode: any',
    });
    await rig.write('big.js', "process.stdout.write('A'.repeat(1000) + 'Z');");
    const reply = (await rig.call('restricted_shell', { argv: [NODE, 'big.js'] })) as {
      stdout: string;
    };
    expect(reply.stdout.startsWith('AAAA')).toBe(true);
    expect(reply.stdout).not.toContain('Z');
  });
});

describeWithLauncher('the semaphore of the heavy commands', () => {
  async function slowRig(extra = ''): Promise<ToolsRig> {
    const rig = await rigOf({
      tools: `  heavy_concurrency: 1\n  commands:\n    test: [node, slow.js]\n    install: [node, slow.js]${extra}`,
    });
    await rig.write('slow.js', 'setTimeout(() => console.log("done"), 600);');
    return rig;
  }

  it('makes two heavy commands wait, one after the other', async () => {
    const rig = await slowRig();
    const started = Date.now();
    const [first, second] = await Promise.all([
      rig.call('run_tests', {}),
      rig.call('install_deps', {}),
    ]);
    const elapsed = Date.now() - started;
    expect(first).toMatchObject({ exitCode: 0 });
    expect(second).toMatchObject({ exitCode: 0 });
    // Two runs of at least 600 ms, in series.
    expect(elapsed).toBeGreaterThanOrEqual(1_150);

    const finished = eventsOf(rig, 'tool.finished').map(
      (event) =>
        event.payload as {
          queuedMs: number;
          tool: string;
        },
    );
    expect(finished).toHaveLength(2);
    const queued = finished.map((payload) => payload.queuedMs).sort((a, b) => a - b);
    expect(queued[0]).toBeLessThan(300);
    expect(queued[1]).toBeGreaterThanOrEqual(400);
    expect(
      eventsOf(rig, 'tool.called').map((event) => (event.payload as { heavy: boolean }).heavy),
    ).toEqual([true, true]);
  }, 30_000);

  it('runs two heavy commands together when heavy_concurrency is 2', async () => {
    const rig = await rigOf({
      tools:
        '  heavy_concurrency: 2\n  commands:\n    test: [node, slow.js]\n    install: [node, slow.js]',
    });
    await rig.write('slow.js', 'setTimeout(() => console.log("done"), 800);');
    const started = Date.now();
    await Promise.all([rig.call('run_tests', {}), rig.call('install_deps', {})]);
    expect(Date.now() - started).toBeLessThan(1_550);
  }, 30_000);

  it('does not queue a command that is not heavy', async () => {
    const rig = await slowRig();
    const started = Date.now();
    const [, shell] = await Promise.all([
      rig.call('run_tests', {}),
      rig.call('restricted_shell', { argv: ['ls'] }),
    ]);
    expect(shell).toMatchObject({ exitCode: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    const called = eventsOf(rig, 'tool.called').map(
      (event) =>
        event.payload as {
          tool: string;
          heavy: boolean;
        },
    );
    expect(called.find((payload) => payload.tool === 'restricted_shell')?.heavy).toBe(false);
    const queuedOfShell = eventsOf(rig, 'tool.finished')
      .map((event) => event.payload as { tool: string; queuedMs: number })
      .find((payload) => payload.tool === 'restricted_shell')?.queuedMs;
    expect(queuedOfShell).toBe(0);
  }, 30_000);

  it('frees the permit when a heavy command fails', async () => {
    const rig = await rigOf({ tools: '  commands:\n    test: [node, boom.js]' });
    await rig.write('boom.js', 'process.exit(3);');
    expect(await rig.call('run_tests', {})).toMatchObject({ exitCode: 3 });
    expect(await rig.call('run_tests', {})).toMatchObject({ exitCode: 3 });
    expect((await rig.fail('install_deps', {})).code).toBe('no_command');
    expect(await rig.call('run_tests', {})).toMatchObject({ exitCode: 3 });
  });
});

describeWithLauncher('tool.called and tool.finished', () => {
  it('record every call, in order, with the correlation of the attempt', async () => {
    const rig = await rigOf();
    await rig.call('restricted_shell', { argv: ['ls'] });
    await rig.fail('restricted_shell', { argv: ['rm'] });
    expect(rig.events.map((event) => event.type)).toEqual([
      'tool.called',
      'tool.finished',
      'tool.called',
      'tool.finished',
    ]);
    expect(rig.events[0]?.payload).toMatchObject({
      tool: 'restricted_shell',
      role: 'actor',
      summary: 'ls',
      heavy: false,
      playId: 'p1',
      demandId: 'd1',
      attemptId: 'p1/d1/1',
    });
    expect(rig.events[1]?.payload).toMatchObject({ outcome: 'ok', exitCode: 0 });
    expect(rig.events[3]?.payload).toMatchObject({
      outcome: 'refused',
      errorCode: 'program_not_allowed',
    });
  });

  it('does not fail the call when the event cannot be written', async () => {
    const rig = await rigOf();
    const reply = await rig.call(
      'restricted_shell',
      { argv: ['ls'] },
      {
        record: () => Promise.reject(new Error('journal is down')),
      },
    );
    expect(reply).toMatchObject({ exitCode: 0 });
  });

  it('keeps the file system untouched by a refused call', async () => {
    const rig = await rigOf();
    await writeFile(join(rig.worktree, 'keep.txt'), 'keep\n');
    await rig.fail('restricted_shell', { argv: ['rm', 'keep.txt'] });
    expect(await rig.call('restricted_shell', { argv: ['cat', 'keep.txt'] })).toMatchObject({
      stdout: 'keep\n',
    });
  });
});

describeWithLauncher('the commands inside the sandbox (layer 3, P4)', () => {
  it('runs the launch the sandbox hands back, with the worktree of the call', async () => {
    const seen: { cmd: string; worktree: string }[] = [];
    const rig = await rigOf({
      confine: (launch, worktree) => {
        seen.push({ cmd: launch.cmd, worktree });
        // What a wrapper does: the same command, run by another one.
        return Promise.resolve({
          ...launch,
          cmd: 'env',
          args: ['CONFINED=yes', launch.cmd, ...launch.args],
        });
      },
    });
    const reply = await rig.call('restricted_shell', { argv: ['ls'] });
    expect(reply).toMatchObject({ exitCode: 0 });
    expect(seen).toEqual([{ cmd: 'ls', worktree: rig.worktree }]);
  });

  it('does NOT run the command when the sandbox cannot wrap it', async () => {
    const real = defaultLauncher();
    if (real === undefined) throw new Error('this platform has no process launcher');
    let launches = 0;
    const rig = await rigOf({
      launcher: {
        id: real.id,
        implements: real.implements,
        capabilities: () => real.capabilities(),
        launch: (options) => {
          launches += 1;
          return real.launch(options);
        },
      } satisfies ProcessLauncher,
      confine: () => Promise.reject(new Error('the sandbox is gone')),
    });
    await expect(rig.call('restricted_shell', { argv: ['ls'] })).rejects.toThrow(/sandbox is gone/);
    expect(launches).toBe(0);
  });
});
