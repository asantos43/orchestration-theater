// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { InkPatchDeps } from './ink-patch.js';
import type { InkPatchName } from './settings.js';
import {
  FakeStdin,
  FakeTty,
  KEYS,
  TERMINAL,
  fixedConnector,
  plain,
  waitFor,
} from './ink.test-support.js';
import { startTui, type StartedTui } from './start.js';
import type { ProcessHost } from './terminal.js';

/**
 * `startTui` is the whole start: the decision about the patches of Ink, then the app. The real
 * Ink runs on a terminal that records what it is told, and the version of Ink that "is installed"
 * is the one the test says.
 */

function fakeProcess(): ProcessHost {
  const bus = new EventEmitter();
  return {
    on: (event: string, listener: (...args: never[]) => void) =>
      bus.on(event, listener as (...args: unknown[]) => void),
    off: (event: string, listener: (...args: never[]) => void) =>
      bus.off(event, listener as (...args: unknown[]) => void),
  };
}

interface Started {
  readonly tui: StartedTui;
  readonly tty: FakeTty;
  readonly stdin: FakeStdin;
  readonly hooks: { readonly patches: readonly InkPatchName[]; readonly version: string }[];
}

async function start(inkVersion: string | undefined, ui?: unknown): Promise<Started> {
  const tty = new FakeTty();
  const stdin = new FakeStdin();
  const hooks: { patches: readonly InkPatchName[]; version: string }[] = [];
  const inkPatchDeps: InkPatchDeps = {
    readInkVersion: () => inkVersion,
    registerHook: (patches, version) => {
      hooks.push({ patches, version });
      return Promise.resolve();
    },
  };
  const tui = await startTui({
    ui,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: tty as unknown as NodeJS.WriteStream,
    stderr: new FakeTty() as unknown as NodeJS.WriteStream,
    process: fakeProcess(),
    env: { LANG: 'en_US.UTF-8' },
    connector: fixedConnector({ kind: 'offline' }),
    inkPatchDeps,
    interactive: true,
  });
  await waitFor(() => tty.wrote('No daemon is running') || undefined, 'the first screen');
  return { tui, tty, stdin, hooks };
}

async function quit(started: Started): Promise<void> {
  started.stdin.write(KEYS.ctrlQ);
  await expect(started.tui.done).resolves.toBe(0);
  // The terminal is back: main screen and cursor, and nothing of the app after them.
  const off = started.tty.lastIndexOf(TERMINAL.alternateOff);
  expect(off).toBeGreaterThan(started.tty.lastIndexOf(TERMINAL.alternateOn));
  expect(started.tty.lastIndexOf(TERMINAL.cursorShow)).toBeGreaterThan(-1);
  expect(plain(started.tty.output.slice(off))).not.toContain('OTheater');
}

describe('startTui, the patches of Ink', () => {
  it('with another version of Ink, refuses the patches, runs the TUI on the original Ink and says so', async () => {
    const started = await start('8.1.0');
    expect(started.tui.patch).toEqual({
      applied: false,
      reason: 'version_mismatch',
      version: '8.1.0',
    });
    // Nothing was registered: the original Ink is what runs.
    expect(started.hooks).toEqual([]);
    const screen = plain(started.tty.output);
    expect(screen).toContain('No daemon is running');
    expect(screen).toContain('The render patches are off: Ink 8.1.0 is installed');
    await quit(started);
  });

  it('with Ink 8.0.0, registers the hook with the patches of ui.render.inkPatches', async () => {
    const started = await start('8.0.0');
    expect(started.tui.patch).toMatchObject({ applied: true, version: '8.0.0' });
    expect(started.hooks).toEqual([{ patches: ['cache', 'grid'], version: '8.0.0' }]);
    expect(plain(started.tty.output)).not.toContain('patches are off');
    await quit(started);
  });

  it('with the version of Ink unknown, runs without the patches and says so', async () => {
    const started = await start(undefined);
    expect(started.tui.patch).toMatchObject({ applied: false, reason: 'ink_not_found' });
    expect(started.hooks).toEqual([]);
    expect(plain(started.tty.output)).toContain('the version of Ink could not be read');
    await quit(started);
  });

  it('with ui.render.inkPatches empty, does not even look at the version, and does not warn', async () => {
    const started = await start('8.1.0', { render: { inkPatches: [] } });
    expect(started.tui.patch).toEqual({ applied: false, reason: 'disabled' });
    expect(started.hooks).toEqual([]);
    expect(plain(started.tty.output)).not.toContain('patches are off');
    await quit(started);
  });

  it('a ui object the TUI cannot read is the same as the defaults', async () => {
    const started = await start('8.0.0', 'not an object');
    expect(started.tui.patch).toMatchObject({ applied: true });
    await quit(started);
  });
});
