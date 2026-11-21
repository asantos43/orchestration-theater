// SPDX-License-Identifier: MPL-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installExitGuards, SIGNAL_EXIT_CODES, type ProcessHost } from './terminal.js';

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
    const off = installExitGuards(host, { onSignal: () => undefined, onFatal: () => undefined });
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
