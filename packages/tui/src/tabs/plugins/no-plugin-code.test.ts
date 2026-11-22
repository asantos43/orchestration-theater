// SPDX-License-Identifier: MPL-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No code of a plugin runs in the TUI (§5.14): the tab draws data the daemon sends. This guard
 * reads the sources of the tab and fails if one of them could load, spawn or evaluate anything:
 * it may import only the protocol, the client, ink, react, i18next and the TUI itself.
 */

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));

const ALLOWED_PACKAGES = new Set([
  '@otheater/client',
  '@otheater/protocol',
  'ink',
  'react',
  'react-i18next',
  'node:crypto',
]);

function imported(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

describe('the sources of the tab Plugins', () => {
  it('are there to be read', () => {
    expect(sources.map((source) => source.name)).toEqual(
      expect.arrayContaining(['api.ts', 'model.ts', 'plugins-tab.tsx', 'index.ts']),
    );
  });

  it('import only the protocol, the client, ink, react and the TUI itself', () => {
    for (const { name, text } of sources) {
      for (const module of imported(text)) {
        const ok = module.startsWith('.') || ALLOWED_PACKAGES.has(module);
        expect(ok, `${name} imports ${module}`).toBe(true);
      }
    }
  });

  it('do not spawn, evaluate or load code', () => {
    const forbidden = [
      /\bchild_process\b/,
      /\bworker_threads\b/,
      /\bnode:vm\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\bprocess\.env\b/,
    ];
    for (const { name, text } of sources) {
      for (const pattern of forbidden)
        expect(text, `${name} matches ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});
