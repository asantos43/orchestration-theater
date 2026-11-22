// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  FakeStdin,
  FakeTty,
  KEYS,
  TERMINAL,
  fixedConnector,
  plain,
  waitFor,
} from './ink.test-support.js';
import { startTuiApp, type RunningTui } from './run.js';
import { DEFAULT_UI_SETTINGS, type KeyboardProtocol, type UiSettings } from './settings.js';
import type { ProcessHost } from './terminal.js';
import type { DaemonConnector } from './daemon-connection.js';

/**
 * The real Ink, on a terminal that records what it is told: is the terminal given back as it was?
 * "As it was" means the main screen is back and the cursor is visible, and that this is the LAST
 * thing written (nothing draws over it afterwards).
 */

interface Session {
  readonly tty: FakeTty;
  readonly err: FakeTty;
  readonly stdin: FakeStdin;
  readonly host: ProcessHost & { readonly bus: EventEmitter };
  readonly running: RunningTui;
}

function fakeProcess(): ProcessHost & { readonly bus: EventEmitter } {
  const bus = new EventEmitter();
  return {
    bus,
    on: (event: string, listener: (...args: never[]) => void) =>
      bus.on(event, listener as (...args: unknown[]) => void),
    off: (event: string, listener: (...args: never[]) => void) =>
      bus.off(event, listener as (...args: unknown[]) => void),
  };
}

async function open(
  connector: DaemonConnector = fixedConnector({ kind: 'offline' }),
  settings: UiSettings = DEFAULT_UI_SETTINGS,
): Promise<Session> {
  const tty = new FakeTty();
  const err = new FakeTty();
  const stdin = new FakeStdin();
  const host = fakeProcess();
  const running = await startTuiApp({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: tty as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    connector,
    settings,
    process: host,
    env: { LANG: 'en_US.UTF-8' },
    interactive: true,
  });
  await waitFor(() => tty.wrote('No daemon is running') || undefined, 'the first screen');
  return { tty, err, stdin, host, running };
}

/** The terminal is back: the main screen and the cursor, in this order, and nothing after them. */
function expectRestored(tty: FakeTty): void {
  expect(tty.wrote(TERMINAL.alternateOn)).toBe(true);
  const off = tty.lastIndexOf(TERMINAL.alternateOff);
  const show = tty.lastIndexOf(TERMINAL.cursorShow);
  expect(off).toBeGreaterThan(tty.lastIndexOf(TERMINAL.alternateOn));
  expect(show).toBeGreaterThan(-1);
  // Nothing of the app is drawn after the screen is given back.
  expect(plain(tty.output.slice(Math.max(off, show)))).not.toContain('OTheater');
}

describe('startTuiApp, the terminal', () => {
  it('enters the alternate screen and draws the app there', async () => {
    const session = await open();
    expect(session.tty.output.indexOf(TERMINAL.alternateOn)).toBeLessThan(
      session.tty.output.indexOf('OTheater'),
    );
    session.running.stop();
    await session.running.done;
  });

  it('Ctrl+Q ends with code 0 and gives the terminal back', async () => {
    const session = await open();
    session.stdin.write(KEYS.ctrlQ);
    await expect(session.running.done).resolves.toBe(0);
    expectRestored(session.tty);
    expect(session.err.output).toBe('');
  });

  it('Ctrl+C is read as a key (Ink does not exit on it): it ends the same way', async () => {
    const session = await open();
    session.stdin.write(KEYS.ctrlC);
    await expect(session.running.done).resolves.toBe(0);
    expectRestored(session.tty);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('%s ends with code %i and gives the terminal back', async (signal, code) => {
    const session = await open();
    session.host.bus.emit(signal);
    await expect(session.running.done).resolves.toBe(code);
    expectRestored(session.tty);
  });

  it('an error nobody caught gives the terminal back, then says what happened in the language of the app', async () => {
    const session = await open();
    session.host.bus.emit('uncaughtException', new Error('boom'));
    await expect(session.running.done).resolves.toBe(1);
    expectRestored(session.tty);
    expect(session.err.output).toContain('The TUI stopped on an error: boom');
    // The message comes after the screen is back, so it is not lost on the alternate screen.
    expect(session.tty.lastIndexOf(TERMINAL.alternateOff)).toBeGreaterThan(-1);
  });

  it('an unhandled rejection is the same', async () => {
    const session = await open();
    session.host.bus.emit('unhandledRejection', 'nope');
    await expect(session.running.done).resolves.toBe(1);
    expectRestored(session.tty);
    expect(session.err.output).toContain('nope');
  });

  it('takes its listeners off the process when it ends', async () => {
    const session = await open();
    for (const event of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      expect(session.host.bus.listenerCount(event)).toBe(1);
    }
    session.running.stop();
    await session.running.done;
    for (const event of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      expect(session.host.bus.listenerCount(event)).toBe(0);
    }
  });

  it('redraws when the terminal is resized', async () => {
    const session = await open();
    session.tty.columns = 60;
    session.tty.rows = 10;
    session.tty.emit('resize');
    await waitFor(() => {
      const frame = plain(session.tty.output).split('╭').at(-1) ?? '';
      const top = /^(─+)╮/.exec(frame);
      return top?.[1]?.length === 58 || undefined;
    }, 'a frame 60 columns wide');
    session.running.stop();
    await session.running.done;
  });

  it('switches the language of the open app when the controller is told to', async () => {
    const session = await open();
    await session.running.locale.apply('pt-BR');
    await waitFor(() => session.tty.wrote('Nenhum daemon está rodando') || undefined, 'Portuguese');
    session.running.stop();
    await session.running.done;
  });
});

/** What Ink writes for the kitty keyboard protocol: the question, the request (flag 1), the pop. */
const KITTY = { query: '\x1b[?u', push: '\x1b[>1u', pop: '\x1b[<u' } as const;

describe('startTuiApp, ui.keyboard.protocol', () => {
  const withProtocol = (protocol: KeyboardProtocol): UiSettings => ({
    ...DEFAULT_UI_SETTINGS,
    keyboard: { protocol },
  });

  it('auto asks the terminal and, as it does not answer, asks for nothing', async () => {
    const session = await open(undefined, withProtocol('auto'));
    expect(session.tty.wrote(KITTY.query)).toBe(true);
    expect(session.tty.wrote(KITTY.push)).toBe(false);
    session.running.stop();
    await session.running.done;
    expectRestored(session.tty);
  });

  it('auto turns the protocol on when the terminal says it knows it', async () => {
    const session = await open(undefined, withProtocol('auto'));
    // `CSI ? flags u` is the answer of a terminal that has the protocol.
    session.stdin.write('\x1b[?0u');
    await waitFor(() => session.tty.wrote(KITTY.push) || undefined, 'the protocol turned on');
    session.running.stop();
    await session.running.done;
    expect(session.tty.lastIndexOf(KITTY.pop)).toBeGreaterThan(session.tty.lastIndexOf(KITTY.push));
  });

  it('kitty turns it on without asking, and turns it off when the app ends', async () => {
    const session = await open(undefined, withProtocol('kitty'));
    expect(session.tty.wrote(KITTY.push)).toBe(true);
    expect(session.tty.wrote(KITTY.query)).toBe(false);
    session.stdin.write(KEYS.ctrlQ);
    await expect(session.running.done).resolves.toBe(0);
    expect(session.tty.lastIndexOf(KITTY.pop)).toBeGreaterThan(session.tty.lastIndexOf(KITTY.push));
    expectRestored(session.tty);
  });

  it('kitty turns it off when the terminal is gone and the app ends with 129', async () => {
    const session = await open(undefined, withProtocol('kitty'));
    session.host.bus.emit('SIGHUP');
    await expect(session.running.done).resolves.toBe(129);
    expect(session.tty.lastIndexOf(KITTY.pop)).toBeGreaterThan(session.tty.lastIndexOf(KITTY.push));
  });

  it('off neither asks nor turns anything on', async () => {
    const session = await open(undefined, withProtocol('off'));
    session.running.stop();
    await session.running.done;
    for (const sequence of Object.values(KITTY)) expect(session.tty.wrote(sequence)).toBe(false);
  });
});

describe('startTuiApp, a terminal that is gone', () => {
  const errno = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });

  it.each(['EIO', 'EPIPE', 'ENXIO'])(
    'an uncaught %s ends with 129 and writes nothing to the terminal that is gone',
    async (code) => {
      const session = await open();
      const before = session.err.writes.length;
      session.host.bus.emit('uncaughtException', errno(code));
      await expect(session.running.done).resolves.toBe(129);
      // The crash message would be a write to the terminal that failed: it is not written.
      expect(session.err.writes.length).toBe(before);
      expect(session.err.output).toBe('');
    },
  );

  it.each(['stdout', 'stderr', 'stdin'] as const)(
    'an error of %s that says the terminal is gone ends with 129, and does not loop',
    async (stream) => {
      const session = await open();
      const target = { stdout: session.tty, stderr: session.err, stdin: session.stdin }[stream];
      target.emit('error', errno('EIO'));
      // The same error again (the next write fails too) is told once.
      target.emit('error', errno('EIO'));
      await expect(session.running.done).resolves.toBe(129);
      expect(session.err.output).toBe('');
    },
  );

  it('an error of a stream that is not about the terminal is a crash, as before', async () => {
    const session = await open();
    session.tty.emit('error', errno('ENOSPC'));
    await expect(session.running.done).resolves.toBe(1);
    expect(session.err.output).toContain('The TUI stopped on an error');
  });

  it('a crash message that fails to be written does not throw', async () => {
    const session = await open();
    session.err.write = () => {
      throw errno('EIO');
    };
    session.host.bus.emit('uncaughtException', new Error('boom'));
    await expect(session.running.done).resolves.toBe(1);
  });

  it('takes its listeners off the streams when it ends', async () => {
    const session = await open();
    session.running.stop();
    await session.running.done;
    expect(session.tty.listenerCount('error')).toBe(0);
    expect(session.err.listenerCount('error')).toBe(0);
    expect(session.stdin.listenerCount('error')).toBe(0);
  });
});
