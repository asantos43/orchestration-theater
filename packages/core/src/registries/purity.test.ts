// SPDX-License-Identifier: MPL-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything the registries may import besides themselves: zod and two files of the core. */
const ALLOWED_OUTSIDE = new Set(['zod', '../errors.js', '../ports/event-log.js']);

function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

describe('core/src/registries stays pure', () => {
  const files = readdirSync(HERE).filter(
    (name) => name.endsWith('.ts') && !name.includes('.test.'),
  );

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s imports no adapter, no daemon, no protocol and no node module', (file) => {
    for (const specifier of importsOf(readFileSync(join(HERE, file), 'utf8'))) {
      const inside = specifier.startsWith('./');
      expect(inside || ALLOWED_OUTSIDE.has(specifier), `${file} imports ${specifier}`).toBe(true);
    }
  });
});
