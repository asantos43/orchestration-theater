// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InkPatchName } from './settings.js';

/**
 * The only version of Ink the patches of `patches/ink/` were made for (decision N37). The patched
 * `output.js` is a copy of the one of this version: on any other it would replace newer code with
 * old code, so it is refused and the TUI runs on the original Ink.
 */
export const SUPPORTED_INK_VERSION = '8.0.0';

export type InkPatchOutcome =
  | { readonly applied: true; readonly patches: readonly InkPatchName[]; readonly version: string }
  | {
      readonly applied: false;
      readonly reason: InkPatchSkipReason;
      /** The Ink version found, when one was. */
      readonly version?: string | undefined;
    };

export type InkPatchSkipReason =
  /** `ui.render.inkPatches` is empty: the patches are off by choice. */
  | 'disabled'
  /** The installed Ink is not {@link SUPPORTED_INK_VERSION}. */
  | 'version_mismatch'
  /** The version of Ink could not be read. */
  | 'ink_not_found'
  /** This Node has no `module.registerHooks`, or the hook failed to load. */
  | 'hook_unavailable';

export interface InkPatchDeps {
  /** The version of the installed Ink, `undefined` when it cannot be found. */
  readInkVersion(): string | undefined;
  /** Registers the module hook; `patches` is what `globalThis.__otInkPatch` carries. */
  registerHook(patches: readonly InkPatchName[], version: string): Promise<void>;
}

/** The version in the `package.json` of the Ink that `import 'ink'` would load. */
export function readInstalledInkVersion(
  resolve: (id: string) => string = (id) => import.meta.resolve(id),
): string | undefined {
  try {
    // <ink>/build/index.js -> <ink>/package.json
    const manifest = new URL('../package.json', resolve('ink'));
    const parsed = JSON.parse(readFileSync(fileURLToPath(manifest), 'utf8')) as {
      readonly version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export const defaultInkPatchDeps: InkPatchDeps = {
  readInkVersion: () => readInstalledInkVersion(),
  async registerHook(patches, version) {
    const globals = globalThis as { __otInkPatch?: string; __otInkPatchVersion?: string };
    globals.__otInkPatch = patches.join(',');
    globals.__otInkPatchVersion = version;
    await import(new URL('../patches/register.mjs', import.meta.url).href);
  },
};

/**
 * Registers the module hook that swaps `output.js` of Ink, when it is safe. It must run BEFORE the
 * first `import 'ink'`: Node loads a module once. The caller (see `main.ts`) warns the person when
 * the outcome is a refusal that was not asked for (`version_mismatch`, `hook_unavailable`...).
 */
export async function applyInkPatches(
  patches: readonly InkPatchName[],
  deps: InkPatchDeps = defaultInkPatchDeps,
): Promise<InkPatchOutcome> {
  if (patches.length === 0) return { applied: false, reason: 'disabled' };
  const version = deps.readInkVersion();
  if (version === undefined) return { applied: false, reason: 'ink_not_found' };
  if (version !== SUPPORTED_INK_VERSION) {
    return { applied: false, reason: 'version_mismatch', version };
  }
  try {
    await deps.registerHook(patches, version);
  } catch {
    return { applied: false, reason: 'hook_unavailable', version };
  }
  return { applied: true, patches, version };
}
