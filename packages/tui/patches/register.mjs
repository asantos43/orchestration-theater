// SPDX-License-Identifier: MPL-2.0
// Node module hook (module.registerHooks, synchronous): swaps files of Ink for the ones in
// patches/ink/. Loaded by src/ink-patch.ts BEFORE Ink is imported, and only when the installed Ink
// is the exact version the patches were made for (decision N37). The module URL does not change,
// only the text Node loads for it, so the rest of Ink (and anything that imports 'ink') is the
// original. As a second guard, the hook itself reads the package.json of the Ink it is about to
// patch and leaves it alone unless the version is the one in `globalThis.__otInkPatchVersion`.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = new URL('./ink/', import.meta.url);
const PATCHED = ['output.js'];
const INK_FILE = /\/node_modules\/ink\/build\/(.+)$/;

function inkVersionOf(url) {
  try {
    const manifest = new URL('../package.json', url);
    return JSON.parse(readFileSync(fileURLToPath(manifest), 'utf8')).version;
  } catch {
    return undefined;
  }
}

registerHooks({
  load(url, context, nextLoad) {
    const match = INK_FILE.exec(url);
    if (match?.[1] !== undefined && PATCHED.includes(match[1])) {
      const expected = globalThis.__otInkPatchVersion;
      if (expected !== undefined && inkVersionOf(url) === expected) {
        try {
          const source = readFileSync(fileURLToPath(new URL(match[1], dir)), 'utf8');
          return { format: 'module', source, shortCircuit: true };
        } catch {
          // Patch file missing: go on with the original.
        }
      }
    }
    return nextLoad(url, context);
  },
});
