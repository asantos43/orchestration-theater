// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import * as nodeModule from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_INK_VERSION,
  applyInkPatches,
  readInstalledInkVersion,
  type InkPatchDeps,
} from './ink-patch.js';

const run = promisify(execFile);
const TUI_DIR = new URL('..', import.meta.url);
const REGISTER = new URL('../patches/register.mjs', import.meta.url).href;
const HAS_HOOKS = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';

/** Deps that record what the patch did, instead of touching the module system. */
function fakeDeps(version: string | undefined, fail = false): InkPatchDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readInkVersion: () => version,
    registerHook: (patches, found) => {
      calls.push(`${patches.join(',')}@${found}`);
      return fail ? Promise.reject(new Error('no hooks')) : Promise.resolve();
    },
  };
}

describe('applyInkPatches (the decision)', () => {
  it('applies the patches to the exact version they were made for', async () => {
    const deps = fakeDeps(SUPPORTED_INK_VERSION);
    const outcome = await applyInkPatches(['cache', 'grid'], deps);
    expect(outcome).toEqual({ applied: true, patches: ['cache', 'grid'], version: '8.0.0' });
    expect(deps.calls).toEqual(['cache,grid@8.0.0']);
  });

  it('refuses any other version of Ink and registers nothing', async () => {
    for (const version of ['8.0.1', '8.1.0', '7.9.9', '9.0.0', '8.0.0-beta.1']) {
      const deps = fakeDeps(version);
      const outcome = await applyInkPatches(['cache', 'grid'], deps);
      expect(outcome).toEqual({ applied: false, reason: 'version_mismatch', version });
      expect(deps.calls).toEqual([]);
    }
  });

  it('does nothing when the patches are turned off by choice (no version read needed)', async () => {
    const deps = fakeDeps('8.1.0');
    expect(await applyInkPatches([], deps)).toEqual({ applied: false, reason: 'disabled' });
    expect(deps.calls).toEqual([]);
  });

  it('says so when the version cannot be read, or when the hook cannot be registered', async () => {
    expect(await applyInkPatches(['cache'], fakeDeps(undefined))).toEqual({
      applied: false,
      reason: 'ink_not_found',
    });
    expect(await applyInkPatches(['cache'], fakeDeps('8.0.0', true))).toEqual({
      applied: false,
      reason: 'hook_unavailable',
      version: '8.0.0',
    });
  });

  it('reads the version of the Ink that is installed, and that is the supported one', () => {
    expect(readInstalledInkVersion()).toBe(SUPPORTED_INK_VERSION);
    const manifest = JSON.parse(readFileSync(new URL('package.json', TUI_DIR), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Exact version in package.json: a bump of Ink has to go through the patch (N37).
    expect(manifest.dependencies.ink).toBe(SUPPORTED_INK_VERSION);
  });

  it('readInstalledInkVersion gives undefined when Ink cannot be resolved', () => {
    expect(
      readInstalledInkVersion(() => {
        throw new Error('not found');
      }),
    ).toBeUndefined();
  });
});

/**
 * The real hook, in a process of its own (a module is loaded once per process, and this one
 * already loaded Ink): does `output.js` of Ink come out patched?
 */
async function outputIsPatched(
  version: string | undefined,
  patches = 'cache,grid',
): Promise<string> {
  const script = `
    if (${JSON.stringify(version)} !== undefined) {
      globalThis.__otInkPatch = ${JSON.stringify(patches)};
      globalThis.__otInkPatchVersion = ${JSON.stringify(version)};
      await import(${JSON.stringify(REGISTER)});
    }
    const { default: Output } = await import(new URL('./output.js', import.meta.resolve('ink')).href);
    const output = new Output({ width: 4, height: 1 });
    console.log(typeof output.caches.getLines === 'function' ? 'patched' : 'original');
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL(TUI_DIR).pathname,
    timeout: 20_000,
  });
  return stdout.trim();
}

describe.skipIf(!HAS_HOOKS)('the module hook (patches/register.mjs), in a child process', () => {
  it('without the hook, Ink is the original', async () => {
    expect(await outputIsPatched(undefined)).toBe('original');
  });

  it('with the hook for the installed version, output.js is the patched one', async () => {
    expect(await outputIsPatched(SUPPORTED_INK_VERSION)).toBe('patched');
  });

  it('with a hook made for another version, output.js stays the original (second guard)', async () => {
    expect(await outputIsPatched('8.1.0')).toBe('original');
  });
});
