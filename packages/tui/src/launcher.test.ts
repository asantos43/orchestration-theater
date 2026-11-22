// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  TuiNotBuiltError,
  UI_ENV,
  buildTuiCommand,
  defaultMainFile,
  launchTui,
  runtimeFlags,
  type SpawnFn,
} from './launcher.js';

describe('runtimeFlags', () => {
  it('always sets the young heap, and the old heap cap only when it is set', () => {
    expect(
      runtimeFlags({ maxSemiSpaceMB: 2, maxOldSpaceMB: undefined, exitGraceMs: 2000 }),
    ).toEqual(['--max-semi-space-size=2']);
    expect(runtimeFlags({ maxSemiSpaceMB: 4, maxOldSpaceMB: 192, exitGraceMs: 2000 })).toEqual([
      '--max-semi-space-size=4',
      '--max-old-space-size=192',
    ]);
  });
});

describe('buildTuiCommand', () => {
  it('puts the flags of ui.runtime before the file, and carries ui in the environment', () => {
    const ui = { locale: 'pt-BR', runtime: { maxSemiSpaceMB: 3, maxOldSpaceMB: 128 } };
    const command = buildTuiCommand({
      dataDir: '/data',
      ui,
      env: { PATH: '/bin' },
      execPath: '/node',
      mainFile: '/pkg/main.js',
    });
    expect(command.command).toBe('/node');
    expect(command.args).toEqual([
      '--max-semi-space-size=3',
      '--max-old-space-size=128',
      '/pkg/main.js',
      '--data-dir',
      '/data',
    ]);
    expect(command.env.PATH).toBe('/bin');
    expect(JSON.parse(command.env[UI_ENV] ?? '')).toEqual(ui);
  });

  it('works with no ui at all (the defaults)', () => {
    const command = buildTuiCommand({ dataDir: '/d', env: {}, mainFile: '/m.js' });
    expect(command.args.slice(0, 1)).toEqual(['--max-semi-space-size=2']);
    expect(command.env[UI_ENV]).toBe('{}');
  });

  it('runs main.js next to the launcher by default', () => {
    expect(defaultMainFile()).toMatch(/main\.js$/);
  });

  it('in the single executable starts the executable in its tui mode, with the flags in NODE_OPTIONS', () => {
    const ui = { runtime: { maxSemiSpaceMB: 3, maxOldSpaceMB: 128 } };
    const command = buildTuiCommand({
      dataDir: '/data',
      ui,
      env: { PATH: '/bin' },
      execPath: '/opt/ot/otheater',
      sea: true,
    });
    expect(command.command).toBe('/opt/ot/otheater');
    expect(command.args).toEqual(['--ot-internal=tui', '--data-dir', '/data']);
    expect(command.mainFile).toBeUndefined();
    expect(command.env.NODE_OPTIONS).toBe('--max-semi-space-size=3 --max-old-space-size=128');
    expect(JSON.parse(command.env[UI_ENV] ?? '')).toEqual(ui);
  });

  it('in the single executable keeps the NODE_OPTIONS the person already had', () => {
    const command = buildTuiCommand({
      dataDir: '/d',
      env: { NODE_OPTIONS: '--no-warnings' },
      execPath: '/x',
      sea: true,
    });
    expect(command.env.NODE_OPTIONS).toBe('--no-warnings --max-semi-space-size=2');
  });
});

/** A child process the test ends by hand. */
function fakeChild(): ChildProcess & { readonly killed: string[] } {
  const child = new EventEmitter() as ChildProcess & {
    killed: boolean;
    readonly signals: string[];
  };
  const signals: string[] = [];
  Object.assign(child, {
    signals,
    kill: (signal: string) => {
      signals.push(signal);
      return true;
    },
  });
  return Object.assign(child, { killed: signals });
}

describe('launchTui in the single executable', () => {
  it('has no script to look for, so it never says the TUI is not built', async () => {
    const child = fakeChild();
    const exists = (): boolean => false;
    const promise = launchTui(
      { dataDir: '/d', env: {}, execPath: '/x', sea: true },
      { exists, spawn: (() => child) as unknown as SpawnFn, process: new EventEmitter() as never },
    );
    child.emit('exit', 0, null);
    await expect(promise).resolves.toBe(0);
  });
});

describe('launchTui', () => {
  const base = { dataDir: '/d', env: {}, execPath: '/node', mainFile: '/pkg/main.js' };

  it('refuses with TuiNotBuiltError when main.js does not exist, starting nothing', async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned += 1;
      return fakeChild();
    };
    await expect(launchTui(base, { spawn, exists: () => false })).rejects.toMatchObject({
      name: 'TuiNotBuiltError',
      file: '/pkg/main.js',
    });
    expect(new TuiNotBuiltError('/x').message).toMatch(/pnpm build/);
    expect(spawned).toBe(0);
  });

  it('starts the process with the terminal inherited and gives its exit code', async () => {
    const child = fakeChild();
    let seen: { command: string; args: readonly string[]; stdio: unknown } | undefined;
    const spawn: SpawnFn = (command, args, options) => {
      seen = { command, args, stdio: options.stdio };
      return child;
    };
    const host = new EventEmitter();
    const done = launchTui(base, {
      spawn,
      exists: () => true,
      process: host as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    });
    expect(seen?.command).toBe('/node');
    expect(seen?.stdio).toBe('inherit');
    child.emit('exit', 3, null);
    await expect(done).resolves.toBe(3);
  });

  it('passes the signals on while it runs, takes the listeners off afterwards, and maps a killed child to 128+n', async () => {
    const child = fakeChild();
    const host = new EventEmitter();
    const done = launchTui(base, {
      spawn: () => child,
      exists: () => true,
      process: host as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    });
    expect(host.listenerCount('SIGTERM')).toBe(1);
    host.emit('SIGTERM');
    expect(child.killed).toEqual(['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    await expect(done).resolves.toBe(143);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      expect(host.listenerCount(signal)).toBe(0);
    }
  });

  it('rejects when the process cannot be started', async () => {
    const child = fakeChild();
    const done = launchTui(base, {
      spawn: () => child,
      exists: () => true,
      process: new EventEmitter() as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    });
    child.emit('error', new Error('spawn failed'));
    await expect(done).rejects.toThrow('spawn failed');
  });
});
