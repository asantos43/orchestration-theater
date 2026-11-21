// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  endProcess,
  installExitGuards,
  isTerminalGone,
  SIGNAL_EXIT_CODES,
  type ProcessHost,
} from './terminal.js';

/** A stand-in for `process`: events by hand, with the listener counts to see what stayed. */
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

describe('installExitGuards', () => {
  it('turns each signal and each uncaught error into a call, and gives the codes of a shell', () => {
    const host = fakeProcess();
    const signals: string[] = [];
    const fatals: unknown[] = [];
    installExitGuards(host, {
      onSignal: (signal) => signals.push(signal),
      onFatal: (error) => fatals.push(error),
      onTerminalGone: () => undefined,
    });
    host.bus.emit('SIGINT');
    host.bus.emit('SIGTERM');
    host.bus.emit('SIGHUP');
    const boom = new Error('boom');
    host.bus.emit('uncaughtException', boom);
    host.bus.emit('unhandledRejection', 'reason');
    expect(signals).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(fatals).toEqual([boom, 'reason']);
    expect(SIGNAL_EXIT_CODES).toEqual({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  });

  it('the function it returns takes every listener off', () => {
    const host = fakeProcess();
    const off = installExitGuards(host, {
      onSignal: () => undefined,
      onFatal: () => undefined,
      onTerminalGone: () => undefined,
    });
    for (const event of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      expect(host.bus.listenerCount(event)).toBe(1);
    }
    off();
    for (const event of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      expect(host.bus.listenerCount(event)).toBe(0);
    }
  });
});

describe('a terminal that is gone', () => {
  const errno = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });

  it('is told by the code of the error: EIO, EPIPE and ENXIO, and nothing else', () => {
    for (const code of ['EIO', 'EPIPE', 'ENXIO']) expect(isTerminalGone(errno(code))).toBe(true);
    for (const other of [errno('ENOENT'), new Error('boom'), 'EIO', null, undefined, 5]) {
      expect(isTerminalGone(other)).toBe(false);
    }
  });

  it('is not an error to report: an uncaught one of those goes to onTerminalGone, not to onFatal', () => {
    const host = fakeProcess();
    const fatals: unknown[] = [];
    let gone = 0;
    installExitGuards(host, {
      onSignal: () => undefined,
      onFatal: (error) => fatals.push(error),
      onTerminalGone: () => (gone += 1),
    });
    host.bus.emit('uncaughtException', errno('EIO'));
    host.bus.emit('unhandledRejection', errno('EPIPE'));
    expect(gone).toBe(2);
    expect(fatals).toEqual([]);
  });
});

describe('endProcess', () => {
  function fakes() {
    const calls: string[] = [];
    let pending: (() => void) | undefined;
    let unref = false;
    const host = {
      exit: (code: number) => calls.push(`exit ${String(code)}`),
      setExitCode: (code: number) => calls.push(`code ${String(code)}`),
    };
    const timers = {
      set: (callback: () => void, ms: number) => {
        calls.push(`timer ${String(ms)}`);
        pending = callback;
        return {
          unref: () => {
            unref = true;
          },
        };
      },
    };
    return { calls, host, timers, fire: () => pending?.(), unrefd: () => unref };
  }

  it('sets the code, then forces the exit after the grace with an unref timer', () => {
    const { calls, host, timers, fire, unrefd } = fakes();
    endProcess(129, 2000, host, timers);
    expect(calls).toEqual(['code 129', 'timer 2000']);
    expect(unrefd()).toBe(true);
    fire();
    expect(calls).toEqual(['code 129', 'timer 2000', 'exit 129']);
  });

  it('exits at once with a grace of 0', () => {
    const { calls, host, timers } = fakes();
    endProcess(0, 0, host, timers);
    expect(calls).toEqual(['code 0', 'exit 0']);
  });
});
