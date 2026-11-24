// SPDX-License-Identifier: MPL-2.0
import { createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Metafile } from 'esbuild';
import { collectTextAssets, type NativeAsset } from './assets.js';
import { entryFiles, entrySource } from './entry.js';
import { installedInkVersion, newPluginState, releasePlugins } from './plugins.js';
import { requireFile } from './resolve.js';
import type { TargetInfo } from './targets.js';

/**
 * What `import.meta` is in the bundle: the module URL points at the executable (the code that derives a
 * folder from it only does so to have a default, and every such place reads an asset in a SEA), and
 * `import.meta.resolve`, which the TUI uses only in the checkout, throws. [proposta]
 */
export const IMPORT_META_BANNER = `const __otImportMeta = {
  url: require('node:url').pathToFileURL(process.execPath).href,
  resolve() {
    throw new Error('import.meta.resolve is not available in the single executable');
  },
};
`;

export interface BundleOptions {
  readonly root: string;
  readonly target: TargetInfo;
  /** Where `ot.cjs`, `metafile.json` and the like go. */
  readonly outDir: string;
  /** The version `--version` prints. */
  readonly version: string;
  /** The Ink version the patches were made for. */
  readonly supportedInk: string;
  /** Minify the bundle. Default false: readable stack traces matter more than a few MB. [proposta] */
  readonly minify?: boolean | undefined;
  /**
   * The text of the public key the daemon in the executable checks release manifests with (the define
   * `__OT_UPDATE_PUBLIC_KEY__`). Read it with {@link readUpdatePublicKey}: a release build has no
   * default and no fallback.
   */
  readonly updatePublicKey: string;
}

export interface BundleResult {
  /** The CommonJS file the SEA runs. */
  readonly file: string;
  readonly metafile: Metafile;
  readonly natives: readonly NativeAsset[];
  readonly inkPatchedVersion: string | undefined;
  readonly warnings: readonly string[];
}

/**
 * Reads the public key file of a release build (`tools/release/keys/update-public-key.pem`). The
 * file must exist and hold either the word PLACEHOLDER (the owner has not made the production key,
 * N246: the daemon then checks nothing, as today) or an Ed25519 public key in PEM. A missing file,
 * an empty one or any other content stops the build: an executable that cannot verify updates
 * must not be made by accident (finding of the review of 2026-11-23, P8a).
 */
export function readUpdatePublicKey(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`the update public key file is missing or unreadable: ${file}`);
  }
  if (/^\s*PLACEHOLDER\s*$/u.test(text)) return text;
  try {
    if (createPublicKey(text).asymmetricKeyType === 'ed25519') return text;
  } catch {
    // falls through to the error below
  }
  throw new Error(`${file} is neither the PLACEHOLDER nor an Ed25519 public key in PEM`);
}

/**
 * The `define` map of the bundle: the version, the Ink patch version, the update public key,
 * `import.meta`, the build mode.
 */
export function bundleDefines(
  version: string,
  inkPatchedVersion: string | undefined,
  updatePublicKey: string,
): Record<string, string> {
  return {
    'import.meta': '__otImportMeta',
    __OT_BUILD_VERSION__: JSON.stringify(version),
    __OT_UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey),
    __OT_INK_PATCHED_VERSION__:
      inkPatchedVersion === undefined ? 'undefined' : JSON.stringify(inkPatchedVersion),
    // React and Ink pick their development or production build from this.
    'process.env.NODE_ENV': '"production"',
  };
}

/**
 * Bundles the daemon (the `ot` CLI), the shim and the TUI into one CommonJS file. The inputs are the
 * compiled `dist` folders of the workspace packages: build them first.
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const { root, target } = options;
  const files = entryFiles(root);
  for (const [what, file] of Object.entries(files) as [string, string][]) requireFile(file, what);
  const state = newPluginState();
  const warnings: string[] = [];
  // The patched `output.js` is for one exact Ink version (decision N37); with another, the original
  // runs and the TUI says so, as in the checkout.
  const inkVersion = installedInkVersion(root);
  const inkPatchedVersion = inkVersion === options.supportedInk ? inkVersion : undefined;
  if (inkPatchedVersion === undefined) {
    warnings.push(
      `Ink ${inkVersion} is not ${options.supportedInk}, the version the patches were made for: the TUI in the executable runs the original Ink`,
    );
  }
  mkdirSync(options.outDir, { recursive: true });
  const outfile = path.join(options.outDir, 'ot.cjs');
  const result = await build({
    stdin: { contents: entrySource(files), resolveDir: root, sourcefile: 'ot-sea-entry.js' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile,
    write: false,
    metafile: true,
    logLevel: 'silent',
    legalComments: 'eof',
    minify: options.minify ?? false,
    banner: { js: IMPORT_META_BANNER },
    define: bundleDefines(options.version, inkPatchedVersion, options.updatePublicKey),
    plugins: releasePlugins({ root, target, patchInk: inkPatchedVersion !== undefined, state }),
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error('esbuild produced no output');
  writeFileSync(outfile, output.contents);
  const metafile = result.metafile;
  writeFileSync(path.join(options.outDir, 'metafile.json'), JSON.stringify(metafile));
  return {
    file: outfile,
    metafile,
    natives: dedupeNatives(state.natives),
    inkPatchedVersion,
    warnings: [...warnings, ...result.warnings.map((w) => w.text)],
  };
}

function dedupeNatives(list: readonly NativeAsset[]): NativeAsset[] {
  return [...new Map(list.map((item) => [item.key, item])).values()];
}

/** The text assets and the native ones as `[key, file]` pairs for the SEA config. */
export function assetFiles(
  root: string,
  natives: readonly NativeAsset[],
): { key: string; file: string }[] {
  return [...collectTextAssets(root), ...natives].map(({ key, file }) => ({ key, file }));
}

/** Reads the version the executable reports when the config does not override it. */
export function readBuildVersion(root: string, override: string | null): string {
  if (override !== null) return override;
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'packages', 'daemon', 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string')
    throw new Error('packages/daemon/package.json has no version');
  return manifest.version;
}
