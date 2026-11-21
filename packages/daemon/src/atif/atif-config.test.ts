// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';

describe('the atif block of the config (P5, N219)', () => {
  it('defaults to one file per play, the full content, written when the play ends', () => {
    expect(parseConfig('').atif).toEqual({
      export: { unit: 'play', content: 'full', on: 'play_end', dir: 'trajectories' },
    });
    expect(parseConfig('atif: {}\n').atif.export.on).toBe('play_end');
  });

  it.each([
    ['unit', 'attempt'],
    ['unit', 'play_files'],
    ['content', 'redacted'],
    ['on', 'manual'],
    ['dir', '/var/otheater/trajectories'],
  ])('accepts %s: %s', (key, value) => {
    expect(
      (
        parseConfig(`atif:\n  export:\n    ${key}: ${value}\n`).atif.export as Record<
          string,
          string
        >
      )[key],
    ).toBe(value);
  });

  it.each([
    ['attempt_end with the unit attempt', 'attempt'],
    ['attempt_end with the unit play_files', 'play_files'],
  ])('accepts %s', (_name, unit) => {
    const config = parseConfig(`atif:\n  export:\n    unit: ${unit}\n    on: attempt_end\n`);
    expect(config.atif.export).toMatchObject({ unit, on: 'attempt_end' });
  });

  it('refuses attempt_end with the unit play, which writes one file per play', () => {
    expect(() => parseConfig('atif:\n  export:\n    on: attempt_end\n')).toThrow(InvalidInput);
    expect(() => parseConfig('atif:\n  export:\n    unit: play\n    on: attempt_end\n')).toThrow(
      /atif\.export\.unit attempt or play_files/,
    );
  });

  it.each([
    ['an unknown mode of unit', 'atif:\n  export:\n    unit: all\n'],
    ['an unknown mode of content', 'atif:\n  export:\n    content: none\n'],
    ['an unknown mode of on', 'atif:\n  export:\n    on: always\n'],
    ['an empty dir', 'atif:\n  export:\n    dir: ""\n'],
    ['an unknown key in export', 'atif:\n  export:\n    colour: red\n'],
    ['an unknown key in atif', 'atif:\n  upload: true\n'],
  ])('rejects %s', (_name, text) => {
    expect(() => parseConfig(text)).toThrow(InvalidInput);
  });
});
