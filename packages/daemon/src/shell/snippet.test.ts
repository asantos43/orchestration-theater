// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { cleanOutput, cutSnippet, linesOf, MAX_LINE_CHARS, seemsToAskForInput } from './snippet.js';

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n';

describe('cleanOutput', () => {
  it('drops colours, titles and cursor moves, and reads \\r\\n as \\n', () => {
    expect(
      cleanOutput('\u001b[31mred\u001b[0m\r\n\u001b]0;title\u0007ok\n\u001b[2K\u001b[1Gdone'),
    ).toBe('red\nok\ndone');
  });

  it('keeps the last version of a line that was redrawn with a lone \\r', () => {
    expect(cleanOutput('10%\r50%\r100%\nnext\n')).toBe('100%\nnext\n');
  });
});

describe('linesOf', () => {
  it('does not count the newline that ends the output as a line', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('a\nb\n')).toEqual(['a', 'b']);
    expect(linesOf('a\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('cutSnippet (terminal.snippet.max_lines)', () => {
  it('keeps an output that fits whole', () => {
    expect(cutSnippet(numbered(3), 200, 'tail')).toEqual({
      text: 'line 1\nline 2\nline 3',
      totalLines: 3,
      shownLines: 3,
      keep: 'tail',
    });
  });

  it('keeps the last lines by default and the first ones with head', () => {
    const tail = cutSnippet(numbered(50), 5, 'tail');
    expect(tail).toMatchObject({ totalLines: 50, shownLines: 5 });
    expect(tail.text).toBe('line 46\nline 47\nline 48\nline 49\nline 50');
    const head = cutSnippet(numbered(50), 5, 'head');
    expect(head).toMatchObject({ totalLines: 50, shownLines: 5, keep: 'head' });
    expect(head.text).toBe('line 1\nline 2\nline 3\nline 4\nline 5');
  });

  it('cuts a line that is too long (the log keeps it whole)', () => {
    const out = cutSnippet(`${'x'.repeat(MAX_LINE_CHARS + 10)}\n`, 10, 'tail');
    expect(out.text).toBe(`${'x'.repeat(MAX_LINE_CHARS)}…`);
  });

  it('is empty for no output', () => {
    expect(cutSnippet('', 10, 'tail')).toMatchObject({ text: '', totalLines: 0, shownLines: 0 });
  });
});

describe('seemsToAskForInput', () => {
  it('sees a prompt left on the last line with no newline', () => {
    expect(seemsToAskForInput('Continue? ', 1)).toBe(true);
    expect(seemsToAskForInput('building\nProceed [y/N] ', 0)).toBe(true);
    expect(seemsToAskForInput('Password:', 1)).toBe(true);
  });

  it('sees a failure that says it found no input', () => {
    expect(seemsToAskForInput('Traceback\nEOFError: EOF when reading a line\n', 1)).toBe(true);
    expect(seemsToAskForInput('the input device is not a TTY\n', 1)).toBe(true);
  });

  it('does not take an ordinary output for a question', () => {
    expect(seemsToAskForInput('', 0)).toBe(false);
    expect(seemsToAskForInput('all good\n', 0)).toBe(false);
    expect(seemsToAskForInput('ready? yes\n', 0)).toBe(false);
    // the words alone, with a success, are not a sign
    expect(seemsToAskForInput('read EOF marker from the file\n', 0)).toBe(false);
  });
});
