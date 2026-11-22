// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { resolveExecutable } from './resolve.js';

const files = (...present: string[]) => {
  const set = new Set(present.map((path) => path.toLowerCase()));
  return (path: string): boolean => set.has(path.toLowerCase());
};

const base = {
  cwd: 'C:\\work\\project',
  env: { Path: 'C:\\tools;"C:\\Program Files\\nodejs";;C:\\Windows' },
} as const;

describe('resolveExecutable', () => {
  it('finds a bare name in PATH (any case of the variable), adding .exe', () => {
    const isFile = files('C:\\Program Files\\nodejs\\node.exe');
    expect(resolveExecutable('node', { ...base, isFile })).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
  });

  it('takes the first folder of PATH that has it, and .exe before .com', () => {
    const isFile = files('C:\\tools\\tool.com', 'C:\\tools\\tool.exe', 'C:\\Windows\\tool.exe');
    expect(resolveExecutable('tool', { ...base, isFile })).toBe('C:\\tools\\tool.exe');
  });

  it('uses the extension it was given and does not search the current directory', () => {
    const isFile = files('C:\\work\\project\\agent.exe', 'C:\\tools\\agent.exe');
    expect(resolveExecutable('agent.exe', { ...base, isFile })).toBe('C:\\tools\\agent.exe');
  });

  it('takes a path with a folder part as it is, relative ones from the cwd', () => {
    const isFile = files('D:\\bin\\agent.exe', 'C:\\work\\project\\bin\\agent.exe');
    expect(resolveExecutable('D:\\bin\\agent.exe', { ...base, isFile })).toBe('D:\\bin\\agent.exe');
    expect(resolveExecutable('bin/agent', { ...base, isFile })).toBe(
      'C:\\work\\project\\bin\\agent.exe',
    );
  });

  it('falls back to the PATH of the daemon when the child env has none', () => {
    const isFile = files('C:\\daemon\\bin\\x.exe');
    expect(
      resolveExecutable('x', {
        cwd: base.cwd,
        env: {},
        fallbackEnv: { PATH: 'C:\\daemon\\bin' },
        isFile,
      }),
    ).toBe('C:\\daemon\\bin\\x.exe');
  });

  it('refuses .cmd and .bat, named or found behind a bare name, saying what to do', () => {
    const isFile = files('C:\\tools\\codex.cmd');
    expect(() => resolveExecutable('codex.cmd', { ...base, isFile })).toThrow(/real executable/);
    expect(() => resolveExecutable('setup.BAT', { ...base, isFile })).toThrow(/\.cmd or \.bat/);
    // The shim of a package manager: the name resolves only to a script.
    expect(() => resolveExecutable('codex', { ...base, isFile })).toThrow(/codex\.cmd/);
    expect(() => resolveExecutable('codex', { ...base, isFile })).toThrow(
      expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error,
    );
  });

  it('rejects with ADAPTER_UNAVAILABLE when nothing resolves', () => {
    const isFile = files();
    expect(() => resolveExecutable('ghost', { ...base, isFile })).toThrow(
      expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error,
    );
    expect(() => resolveExecutable('C:\\nowhere\\ghost.exe', { ...base, isFile })).toThrow(
      /at that path/,
    );
  });
});
