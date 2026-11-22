// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_NOT_AVAILABLE, EXIT_UNKNOWN_MODE, parseInternalMode, runSeaMain } from './main.js';

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
});

function harness() {
  const calls: string[] = [];
  const written: string[] = [];
  const handlers = {
    tui: vi.fn((argv: readonly string[]) => {
      calls.push(`tui:${argv.join(',')}`);
      return Promise.resolve();
    }),
    cli: vi.fn(() => {
      calls.push('cli');
      return Promise.resolve();
    }),
    mcpShim: vi.fn(() => {
      calls.push('mcp-shim');
      return Promise.resolve();
    }),
    stderr: { write: (text: string) => written.push(text) },
  };
  return { calls, written, handlers };
}

describe('parseInternalMode', () => {
  it('is the CLI with no argument or with an ordinary one', () => {
    expect(parseInternalMode([])).toEqual({ kind: 'cli' });
    expect(parseInternalMode(['status'])).toEqual({ kind: 'cli' });
  });

  it('reads the mode only from the first argument', () => {
    expect(parseInternalMode(['--ot-internal=tui', '--data-dir', '/d'])).toEqual({
      kind: 'mode',
      mode: 'tui',
      rest: ['--data-dir', '/d'],
    });
    expect(parseInternalMode(['status', '--ot-internal=tui'])).toEqual({ kind: 'cli' });
  });

  it('flags a mode that does not exist', () => {
    expect(parseInternalMode(['--ot-internal=nope'])).toEqual({ kind: 'unknown', value: 'nope' });
  });
});

describe('runSeaMain', () => {
  it('runs the CLI with no mode', async () => {
    const { calls, handlers } = harness();
    await runSeaMain(['daemon', 'start'], handlers);
    expect(calls).toEqual(['cli']);
  });

  it('runs the TUI with what follows the mode', async () => {
    const { calls, handlers } = harness();
    await runSeaMain(['--ot-internal=tui', '--data-dir', '/d'], handlers);
    expect(calls).toEqual(['tui:--data-dir,/d']);
  });

  it('relaunches the MCP shim', async () => {
    const { calls, handlers } = harness();
    await runSeaMain(['--ot-internal=mcp-shim'], handlers);
    expect(calls).toEqual(['mcp-shim']);
  });

  it('answers "not available" for the mode of a later step, with exit code 3', async () => {
    const { calls, written, handlers } = harness();
    process.exitCode = undefined;
    await runSeaMain(['--ot-internal=verify-release'], handlers);
    expect(calls).toEqual([]);
    expect(written.join('')).toContain('"verify-release" is not available');
    expect(process.exitCode).toBe(EXIT_NOT_AVAILABLE);
  });

  it('runs the applier by default in apply-update (usage error without --journal)', async () => {
    const { calls, handlers } = harness();
    process.exitCode = undefined;
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runSeaMain(['--ot-internal=apply-update'], handlers);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it('runs a later mode as soon as a build provides it', async () => {
    const { handlers } = harness();
    const applyUpdate = vi.fn(() => Promise.resolve());
    await runSeaMain(['--ot-internal=apply-update', 'x'], { ...handlers, applyUpdate });
    expect(applyUpdate).toHaveBeenCalledWith(['x']);
  });

  it('refuses an unknown mode with exit code 2', async () => {
    const { calls, written, handlers } = harness();
    process.exitCode = undefined;
    await runSeaMain(['--ot-internal=nope'], handlers);
    expect(calls).toEqual([]);
    expect(written.join('')).toContain('unknown internal mode "nope"');
    expect(process.exitCode).toBe(EXIT_UNKNOWN_MODE);
  });
});
