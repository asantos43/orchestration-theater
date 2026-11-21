// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { isShellLine, oneLine, outputLines, shellCommandOf } from './shell.js';

describe('a line that is a ! command', () => {
  it('is the line whose first character that is not blank is !', () => {
    expect(isShellLine('!ls')).toBe(true);
    expect(isShellLine('  !ls -la')).toBe(true);
    expect(isShellLine('ls !')).toBe(false);
    expect(isShellLine('/status')).toBe(false);
    expect(isShellLine('')).toBe(false);
  });

  it('has the command after the !, with the edges trimmed', () => {
    expect(shellCommandOf('!ls')).toBe('ls');
    expect(shellCommandOf('  !   git status  ')).toBe('git status');
    expect(shellCommandOf('!')).toBe('');
    expect(shellCommandOf('!echo hi!')).toBe('echo hi!');
  });
});

describe('oneLine', () => {
  it('flattens the blanks and cuts with an ellipsis past the limit', () => {
    expect(oneLine('a\n  b\tc', 20)).toBe('a b c');
    expect(oneLine('abcdefghij', 5)).toBe('abcd…');
    expect(oneLine('abcde', 5)).toBe('abcde');
  });
});

describe('the lines of the output', () => {
  it('is empty when the snippet is', () => {
    expect(outputLines('')).toEqual([]);
  });

  it('keeps the indentation and the inner blank lines, and drops the blank lines at the end', () => {
    expect(outputLines('a\n  b\n\nc   \n\n')).toEqual(['a', '  b', '', 'c']);
  });

  it('turns a tab into spaces', () => {
    expect(outputLines('a\tb')).toEqual(['a    b']);
  });

  it('takes out the escape sequences and the control characters a program may print', () => {
    expect(
      outputLines('\u001b[31mred\u001b[0m\n\u001b]0;title\u0007ok\u0000\u0007\r\nend'),
    ).toEqual(['red', 'ok', 'end']);
  });
});
