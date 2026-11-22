// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_ADAPTER_FAILED,
  EXIT_NOT_AVAILABLE,
  EXIT_UNKNOWN_MODE,
  parseInternalMode,
  runAdapterEntry,
  runSeaMain,
} from './main.js';

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

  it('answers "not available" for the modes of later steps, with exit code 3', async () => {
    for (const mode of ['verify-release', 'apply-update']) {
      const { calls, written, handlers } = harness();
      process.exitCode = undefined;
      await runSeaMain([`--ot-internal=${mode}`], handlers);
      expect(calls).toEqual([]);
      expect(written.join('')).toContain(`"${mode}" is not available`);
      expect(process.exitCode).toBe(EXIT_NOT_AVAILABLE);
    }
  });

  it('runs a later mode as soon as a build provides it', async () => {
    const { handlers } = harness();
    const applyUpdate = vi.fn(() => Promise.resolve());
    await runSeaMain(['--ot-internal=apply-update', 'x'], { ...handlers, applyUpdate });
    expect(applyUpdate).toHaveBeenCalledWith(['x']);
  });

  it('hands the adapter script and its arguments to run-adapter', async () => {
    const { handlers } = harness();
    const runAdapter = vi.fn(() => Promise.resolve());
    await runSeaMain(['--ot-internal=run-adapter', '/a/index.js', '--x'], {
      ...handlers,
      runAdapter,
    });
    expect(runAdapter).toHaveBeenCalledWith(['/a/index.js', '--x']);
  });

  it('reports a run-adapter that cannot load, with exit code 4', async () => {
    const { written, handlers } = harness();
    process.exitCode = undefined;
    await runSeaMain(['--ot-internal=run-adapter'], handlers);
    expect(written.join('')).toContain('run-adapter failed: run-adapter needs the entry script');
    expect(process.exitCode).toBe(EXIT_ADAPTER_FAILED);
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

describe('runAdapterEntry', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });

  it('loads the script as an ES module with the arguments the adapter would get from node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-run-adapter-'));
    try {
      const script = join(dir, 'index.mjs');
      writeFileSync(
        script,
        'await Promise.resolve();\nglobalThis.__otAdapterArgv = process.argv.slice(1);\n',
      );
      await runAdapterEntry([script, '--flag']);
      expect((globalThis as { __otAdapterArgv?: string[] }).__otAdapterArgv).toEqual([
        script,
        '--flag',
      ]);
    } finally {
      delete (globalThis as { __otAdapterArgv?: string[] }).__otAdapterArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a call without the script', async () => {
    await expect(runAdapterEntry([])).rejects.toThrow('entry script');
  });
});
