// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The guide (docs/25) quotes this package. A quote is marked `<!-- trecho: src/<file> -->` right
// above a fenced block, and the block must be the file, line for line: the text cannot rot while
// the code changes. (This file is read at run time, so it is checked whenever the suite runs.)
const GUIDE = resolve(import.meta.dirname, '../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md');
const PACKAGE = resolve(import.meta.dirname, '..');
const QUOTE = /<!-- trecho: (src\/[\w.-]+) -->\n```ts\n([\s\S]*?)\n```/g;

describe('the guide quotes the example', () => {
  const guide = readFileSync(GUIDE, 'utf8');
  const quotes = [...guide.matchAll(QUOTE)];

  it('quotes the three files of the adapter', () => {
    expect(quotes.map((match) => match[1])).toEqual([
      'src/index.ts',
      'src/clock.ts',
      'src/clock.test.ts',
    ]);
  });

  it.each(quotes.map((match) => [match[1] ?? '', match[2] ?? ''] as const))(
    '%s is the file, unchanged',
    (file, quoted) => {
      expect(readFileSync(resolve(PACKAGE, file), 'utf8').trimEnd()).toBe(quoted);
    },
  );
});
