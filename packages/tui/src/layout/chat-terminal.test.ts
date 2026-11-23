// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { terminalLines, type ChatTerminal } from './chat.js';
import { TERMINAL_PALETTE } from './palette.js';
import { TOKEN } from './theme.js';

const block: ChatTerminal = {
  header: '! ls -la',
  output: ['total 8', '  indented  line', ''],
  notes: [
    { text: 'Finished with code 0 in 1 s.', tone: 'ok' },
    { text: 'The command asked for input.', tone: 'warn' },
    { text: 'Failed.', tone: 'error' },
    { text: 'Kept here.', tone: 'dim' },
  ],
};

describe('the rows of a ! command (P18)', () => {
  it('draws the command line, the output behind a bar and the notes, in that order', () => {
    const rows = terminalLines(block, 40);
    expect(rows.map((row) => row.text)).toEqual([
      '! ls -la',
      '│ total 8',
      '│   indented  line',
      '│ ',
      'Finished with code 0 in 1 s.',
      'The command asked for input.',
      'Failed.',
      'Kept here.',
    ]);
  });

  it('colours the notes by tone and dims only the quiet one', () => {
    const rows = terminalLines(block, 40);
    const note = (text: string) => rows.find((row) => row.text === text);
    // The rows carry roles; in `terminal` they are the named colours the layout always had.
    const named = (text: string) => TERMINAL_PALETTE.resolve(note(text)?.color);
    expect(note('Finished with code 0 in 1 s.')?.color).toBe(TOKEN.ok);
    expect(named('Finished with code 0 in 1 s.')).toBe('green');
    expect(named('The command asked for input.')).toBe('yellow');
    expect(named('Failed.')).toBe('red');
    expect(note('Kept here.')?.dim).toBe(true);
    expect(note('Failed.')?.dim).toBe(false);
    expect(rows[0]?.bold).toBe(true);
  });

  it('breaks a long output line at the width, indentation kept, behind a bar each time', () => {
    const rows = terminalLines({ header: '!', output: ['  0123456789abcdef'], notes: [] }, 10).map(
      (row) => row.text,
    );
    expect(rows).toEqual(['!', '│   012345', '│ 6789abcd', '│ ef']);
    for (const text of rows) expect(text.length).toBeLessThanOrEqual(10);
  });

  it('has no output rows for a command in progress', () => {
    const rows = terminalLines(
      { header: '! sleep 3', output: [], notes: [{ text: 'Running in host…', tone: 'dim' }] },
      40,
    );
    expect(rows.map((row) => row.text)).toEqual(['! sleep 3', 'Running in host…']);
  });
});
