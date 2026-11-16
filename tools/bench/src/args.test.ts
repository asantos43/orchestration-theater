// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from './args.js';

describe('parseCliArgs', () => {
  it('parses the store command with its defaults', () => {
    expect(parseCliArgs(['store', '--dir', '/data/bench'])).toEqual({
      command: 'store',
      dir: '/data/bench',
      quick: false,
      out: undefined,
      section: 'all',
      budgetMinutes: 60,
    });
  });

  it('parses every option', () => {
    expect(
      parseCliArgs([
        'store',
        '--dir',
        'd',
        '--quick',
        '--out',
        'r.json',
        '--section',
        'b',
        '--budget-minutes',
        '5',
      ]),
    ).toEqual({
      command: 'store',
      dir: 'd',
      quick: true,
      out: 'r.json',
      section: 'b',
      budgetMinutes: 5,
    });
  });

  it('shows the help for no command or --help', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help' });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
  });

  it('requires --dir', () => {
    expect(() => parseCliArgs(['store'])).toThrow(/--dir/);
    expect(() => parseCliArgs(['store', '--dir', ''])).toThrow(UsageError);
  });

  it.each([
    [['other', '--dir', 'd'], /Unknown command/],
    [['store', 'extra', '--dir', 'd'], /Unexpected argument/],
    [['store', '--dir', 'd', '--section', 'c'], /--section/],
    [['store', '--dir', 'd', '--budget-minutes', '0'], /--budget-minutes/],
    [['store', '--dir', 'd', '--budget-minutes', 'abc'], /--budget-minutes/],
    [['store', '--dir', 'd', '--nope'], /nope/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});
