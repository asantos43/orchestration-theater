// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  assertNoForbiddenFlags,
  DEFAULT_SHELL_ALLOWLIST,
  matchAllowlist,
  parseAllowEntry,
  splitCommandLine,
  validateArgv,
} from './argv.js';
import { ShellToolRefusal, type ShellRefusalReason } from './refusal.js';

function reasonOf(run: () => void): ShellRefusalReason {
  try {
    run();
  } catch (error) {
    if (error instanceof ShellToolRefusal) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('validateArgv', () => {
  it('accepts a plain program with plain arguments', () => {
    validateArgv(['git', 'status', '--short']);
    validateArgv(['rg', '-n', 'foo(bar)|baz', 'src']);
    validateArgv(['node', 'script.mjs', '--flag=value']);
    validateArgv(['pnpm', 'run', 'build:all']);
  });

  it('refuses an empty list and bad items', () => {
    expect(
      reasonOf(() => {
        validateArgv([]);
      }),
    ).toBe('empty_argv');
    expect(
      reasonOf(() => {
        validateArgv(['ls', 'a\0b']);
      }),
    ).toBe('invalid_argument');
    expect(
      reasonOf(() => {
        validateArgv(['ls', 'x'.repeat(9000)]);
      }),
    ).toBe('invalid_argument');
    expect(
      reasonOf(() => {
        validateArgv(Array.from({ length: 300 }, () => 'x'));
      }),
    ).toBe('invalid_argument');
  });

  it('refuses a program called by path or by expression', () => {
    for (const program of [
      '/bin/ls',
      './run.sh',
      '../x',
      'bin/node',
      'C:\\Windows\\cmd.exe',
      '~/bin/x',
      '-rf',
      '',
      '.',
      'ls;rm',
      'ls rm',
      '$HOME/x',
    ]) {
      expect(
        reasonOf(() => {
          validateArgv([program, 'x']);
        }),
        program,
      ).toBe(program === '' ? 'program_by_path' : 'program_by_path');
    }
  });

  it('refuses chaining as arguments', () => {
    for (const op of [';', '|', '||', '&&', '&', '|&', ';;']) {
      expect(
        reasonOf(() => {
          validateArgv(['ls', 'a', op, 'rm', 'b']);
        }),
        op,
      ).toBe('shell_syntax');
    }
  });

  it('refuses redirection, bare or glued to the target', () => {
    for (const arg of [
      '>',
      '>>',
      '<',
      '<<',
      '<<<',
      '2>',
      '2>&1',
      '&>',
      '>out.txt',
      '2>/dev/null',
      '<in.txt',
    ]) {
      expect(
        reasonOf(() => {
          validateArgv(['cat', 'a', arg]);
        }),
        arg,
      ).toBe('shell_syntax');
    }
  });

  it('refuses expansion, substitution and an operator inside one argument', () => {
    for (const arg of [
      '`id`',
      '$(id)',
      '${HOME}',
      '$HOME',
      'a && b',
      'a ; b',
      'a | b',
      'a || b',
      'x $? y',
    ]) {
      expect(
        reasonOf(() => {
          validateArgv(['echo', arg]);
        }),
        arg,
      ).toBe('shell_syntax');
    }
  });

  it('does not mistake a pattern for shell syntax', () => {
    validateArgv(['rg', 'a|b', 'src']);
    validateArgv(['rg', '^foo$', 'src']);
    validateArgv(['rg', 'a;b', 'src']);
    validateArgv(['git', 'log', '--format=%H %s']);
  });
});

describe('allowlist', () => {
  it('parses an entry into a program and its leading words', () => {
    expect(parseAllowEntry('git status')).toEqual(['git', 'status']);
    expect(parseAllowEntry('  pnpm   run ')).toEqual(['pnpm', 'run']);
    expect(reasonOf(() => parseAllowEntry('/bin/ls'))).toBe('program_by_path');
    expect(reasonOf(() => parseAllowEntry(''))).toBe('program_by_path');
  });

  it('matches by the words an entry names, not by prefix of text', () => {
    const entries = ['git status', 'git log', 'ls', 'pnpm run'];
    expect(matchAllowlist(['git', 'status', '--short'], entries)).toBe(true);
    expect(matchAllowlist(['ls', '-la', 'src'], entries)).toBe(true);
    expect(matchAllowlist(['pnpm', 'run', 'build'], entries)).toBe(true);
    expect(matchAllowlist(['git', 'commit', '-m', 'x'], entries)).toBe(false);
    expect(matchAllowlist(['git'], entries)).toBe(false);
    expect(matchAllowlist(['git', 'statusx'], entries)).toBe(false);
    expect(matchAllowlist(['pnpm', 'add', 'left-pad'], entries)).toBe(false);
    expect(matchAllowlist(['lsof'], entries)).toBe(false);
    expect(matchAllowlist(['ls'], [])).toBe(false);
  });

  it('lets only the reading subcommands of git through in the curated list', () => {
    for (const argv of [
      ['git', 'status'],
      ['git', 'log', '-3'],
      ['git', 'diff', 'HEAD~1'],
      ['git', 'show', 'HEAD'],
      ['git', 'branch', '--list'],
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'ls-files'],
    ]) {
      expect(matchAllowlist(argv, DEFAULT_SHELL_ALLOWLIST), argv.join(' ')).toBe(true);
    }
    for (const argv of [
      ['git', 'commit', '-m', 'x'],
      ['git', 'push'],
      ['git', 'reset', '--hard'],
      ['git', 'checkout', 'main'],
      ['git', 'branch', '-D', 'x'],
      ['git', 'branch', 'new'],
      ['git', 'config', 'user.name', 'x'],
      ['git', 'clean', '-fd'],
      ['git', '-c', 'core.pager=sh', 'status'],
      ['git', 'add', '.'],
      ['rm', '-rf', '.'],
      ['curl', 'http://example.com'],
      ['sh', '-c', 'ls'],
    ]) {
      expect(matchAllowlist(argv, DEFAULT_SHELL_ALLOWLIST), argv.join(' ')).toBe(false);
    }
  });

  it('keeps the default list to valid entries', () => {
    for (const entry of DEFAULT_SHELL_ALLOWLIST) parseAllowEntry(entry);
  });
});

describe('assertNoForbiddenFlags', () => {
  it('refuses the flags that write or launch another program', () => {
    expect(
      reasonOf(() => {
        assertNoForbiddenFlags(['git', 'diff', '--output=x.patch']);
      }),
    ).toBe('forbidden_flag');
    expect(
      reasonOf(() => {
        assertNoForbiddenFlags(['git', 'diff', '--ext-diff']);
      }),
    ).toBe('forbidden_flag');
    expect(
      reasonOf(() => {
        assertNoForbiddenFlags(['rg', '--pre=sh', 'x']);
      }),
    ).toBe('forbidden_flag');
  });

  it('lets the others, and what follows "--"', () => {
    assertNoForbiddenFlags(['git', 'diff', '--stat']);
    assertNoForbiddenFlags(['rg', '--', '--pre']);
    assertNoForbiddenFlags(['ls', '--output']);
  });
});

describe('splitCommandLine', () => {
  it('splits on blanks and keeps quoted words together', () => {
    expect(splitCommandLine('pnpm test --run')).toEqual(['pnpm', 'test', '--run']);
    expect(splitCommandLine(`node -e "console.log(1 + 1)" 'a b'`)).toEqual([
      'node',
      '-e',
      'console.log(1 + 1)',
      'a b',
    ]);
    expect(splitCommandLine('  ')).toEqual([]);
    expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b']);
  });

  it('refuses an unclosed quote', () => {
    expect(reasonOf(() => splitCommandLine('echo "oops'))).toBe('invalid_argument');
  });
});
