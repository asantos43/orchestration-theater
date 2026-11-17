// SPDX-License-Identifier: MPL-2.0
import { DEFAULT_SHELL_ALLOWLIST } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';

describe('the tools block of the config (N97, N98)', () => {
  it('has the owner defaults', () => {
    const tools = parseConfig('').tools;
    expect(tools.shell_allowlist.mode).toBe('list');
    expect(tools.shell_allowlist.list).toEqual([...DEFAULT_SHELL_ALLOWLIST]);
    expect(tools.timeout_ms).toBe(600_000);
    expect(tools.output_max_bytes).toBe(65_536);
    expect(tools.heavy_concurrency).toBe(1);
    expect(tools.heavy_commands).toEqual(['run_tests', 'install_deps']);
    expect(tools.truncate).toBe('head_tail');
    expect(tools.commands).toEqual({});
    expect(tools.http).toEqual({ timeout_ms: 30_000, redirects: 'refuse' });
  });

  it('takes the three modes of the allowlist and refuses another', () => {
    for (const mode of ['list', 'profile', 'any']) {
      expect(
        parseConfig(`tools:\n  shell_allowlist:\n    mode: ${mode}\n`).tools.shell_allowlist.mode,
      ).toBe(mode);
    }
    expect(() => parseConfig('tools:\n  shell_allowlist:\n    mode: all\n')).toThrow(/mode/);
  });

  it('takes a custom list and refuses an entry that is a path or empty', () => {
    const config = parseConfig('tools:\n  shell_allowlist:\n    list: [ls, git status]\n');
    expect(config.tools.shell_allowlist.list).toEqual(['ls', 'git status']);
    expect(() => parseConfig('tools:\n  shell_allowlist:\n    list: [/bin/ls]\n')).toThrow();
    expect(() => parseConfig('tools:\n  shell_allowlist:\n    list: [""]\n')).toThrow();
  });

  it('takes the limits, the heavy tools and the commands of the project', () => {
    const config = parseConfig(
      [
        'tools:',
        '  timeout_ms: 1000',
        '  output_max_bytes: 100',
        '  truncate: tail',
        '  heavy_concurrency: 2',
        '  heavy_commands: [run_tests, install_deps, restricted_shell]',
        '',
      ].join('\n'),
    ).tools;
    expect(config.timeout_ms).toBe(1000);
    expect(config.output_max_bytes).toBe(100);
    expect(config.truncate).toBe('tail');
    expect(config.heavy_concurrency).toBe(2);
    expect(config.heavy_commands).toEqual(['run_tests', 'install_deps', 'restricted_shell']);
  });

  it('takes a command as a line or as an argv', () => {
    const config = parseConfig(
      'tools:\n  commands:\n    test: pnpm test\n    install: [pnpm, install, --frozen-lockfile]\n',
    ).tools;
    expect(config.commands.test).toBe('pnpm test');
    expect(config.commands.install).toEqual(['pnpm', 'install', '--frozen-lockfile']);
  });

  it('refuses bad numbers, an unknown key and an unknown tool', () => {
    expect(() => parseConfig('tools:\n  timeout_ms: 0\n')).toThrow(/timeout_ms/);
    expect(() => parseConfig('tools:\n  heavy_concurrency: 0\n')).toThrow(/heavy_concurrency/);
    expect(() => parseConfig('tools:\n  output_max_bytes: 1.5\n')).toThrow(/output_max_bytes/);
    expect(() => parseConfig('tools:\n  extra: 1\n')).toThrow(/extra/);
    expect(() => parseConfig('tools:\n  heavy_commands: [http_get]\n')).toThrow(/heavy_commands/);
    expect(() => parseConfig('tools:\n  truncate: middle\n')).toThrow(/truncate/);
    expect(() => parseConfig('tools:\n  http:\n    redirects: follow\n')).toThrow(/redirects/);
  });
});
