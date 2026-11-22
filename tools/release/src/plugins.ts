// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import { sha256File, type NativeAsset } from './assets.js';
import { packageDir, readJson } from './resolve.js';
import type { TargetInfo } from './targets.js';

/**
 * The esbuild plugins of the single executable (Phase 10, P1). A SEA runs ONE CommonJS file with no
 * `node_modules` beside it, so the four places that need something the bundle cannot carry are
 * rewritten while the bundle is made, and the source code of the packages is not touched:
 *
 * - `better-sqlite3` and `@napi-rs/keyring` look for a `.node` file on disk. Their loaders are
 *   replaced by a call to `globalThis.__otSeaNative.load` (the entry sets it), which extracts the
 *   addon, an asset of the executable, to the data folder and `dlopen`s it.
 * - `yoga-layout` (Ink) uses a top-level `await` to start its WebAssembly, which CommonJS cannot
 *   express. The entry starts it first (`globalThis.__otYoga`) and the module reads it from there.
 * - `playwright-core` (7 MB) reads its own `package.json` and browser registry from disk at load time,
 *   so it cannot be bundled. The browser adapter uses only `chromium.connectOverCDP`, `errors` and
 *   the Chromium path, so a stub stands in; the executable drives the Chromium the user names in
 *   `browser.executable_path` and the stub says so when it is asked for its own.
 * - Ink's `output.js` is swapped for the patched one of the TUI (decision N37) when the Ink version is
 *   the supported one; the module hook the checkout uses cannot run in a bundle.
 */
export interface PluginState {
  /** The native addons the bundle needs, filled while the plugins run. */
  readonly natives: NativeAsset[];
}

export function newPluginState(): PluginState {
  return { natives: [] };
}

/** The version of the Ink the TUI resolves. */
export function installedInkVersion(root: string): string {
  const inkDir = packageDir('ink', path.join(root, 'packages', 'tui'));
  const version = readJson(path.join(inkDir, 'package.json')).version;
  if (typeof version !== 'string') throw new Error('The installed Ink has no version');
  return version;
}

export interface PluginOptions {
  readonly root: string;
  readonly target: TargetInfo;
  /** Swap Ink's `output.js` for the patched one (the caller checked the Ink version). */
  readonly patchInk: boolean;
  readonly state: PluginState;
}

/** The test Ink's reconciler uses to load React DevTools. */
const INK_DEV_TEST = "process.env['DEV'] === 'true'";

/** The text of the module that replaces the loader of `better-sqlite3` (`lib/binding.js`). */
export function sqliteBindingSource(key: string, sha256: string): string {
  return `'use strict';
let DEFAULT_ADDON;
function getBinding(nativeBinding) {
  if (typeof nativeBinding === 'string') {
    throw new Error('A native addon path is not supported in the single executable');
  }
  if (typeof nativeBinding === 'object' && nativeBinding !== null) return nativeBinding;
  if (DEFAULT_ADDON) return DEFAULT_ADDON;
  return (DEFAULT_ADDON = globalThis.__otSeaNative.load(${JSON.stringify(key)}, ${JSON.stringify(sha256)}));
}
exports.getBinding = getBinding;
exports.getPrebuildPath = () => null;
`;
}

/** The text of the module that replaces `@napi-rs/keyring/index.js`: the same exports from the asset. */
export function keyringIndexSource(key: string, sha256: string): string {
  return `'use strict';
const nativeBinding = globalThis.__otSeaNative.load(${JSON.stringify(key)}, ${JSON.stringify(sha256)});
module.exports = nativeBinding;
module.exports.AsyncEntry = nativeBinding.AsyncEntry;
module.exports.Entry = nativeBinding.Entry;
module.exports.findCredentials = nativeBinding.findCredentials;
module.exports.findCredentialsAsync = nativeBinding.findCredentialsAsync;
module.exports.LinuxStore = nativeBinding.LinuxStore;
`;
}

/** The text of the module that stands for `yoga-layout`: the enums are plain, the engine comes preloaded. */
export function yogaSource(enumsFile: string): string {
  return `export * from ${JSON.stringify(enumsFile)};
const Yoga = globalThis.__otYoga;
if (Yoga === undefined) throw new Error('yoga-layout was not preloaded by the executable entry');
export default Yoga;
`;
}

/** The text of the module that stands for `playwright-core`. */
export const PLAYWRIGHT_STUB_SOURCE = `
const reason = 'playwright-core is not part of the single executable';
export class TimeoutError extends Error {}
export const errors = { TimeoutError };
export const chromium = {
  executablePath() { return '<' + reason + '>'; },
  connectOverCDP() { return Promise.reject(new Error(reason)); },
};
`;

export function releasePlugins(options: PluginOptions): Plugin[] {
  const { root, target, state } = options;
  const adapters = path.join(root, 'packages', 'adapters');
  const sqliteDir = packageDir('better-sqlite3', path.join(adapters, 'store-sqlite'));
  const keyringDir = packageDir('@napi-rs/keyring', path.join(adapters, 'vault-keyring'));
  const inkDir = packageDir('ink', path.join(root, 'packages', 'tui'));
  const yogaDir = packageDir('yoga-layout', inkDir);

  const sqlitePlugin: Plugin = {
    name: 'ot-sqlite-binding',
    setup(build) {
      build.onLoad({ filter: /[\\/]better-sqlite3[\\/]lib[\\/]binding\.js$/ }, (args) => {
        const file = path.join(sqliteDir, 'prebuilds', `${target.sqlitePrebuild}.node`);
        const sha256 = sha256File(file);
        const key = 'native/better_sqlite3.node';
        state.natives.push({ key, file, name: 'better_sqlite3.node', sha256 });
        return {
          contents: sqliteBindingSource(key, sha256),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };

  const keyringPlugin: Plugin = {
    name: 'ot-keyring-binding',
    setup(build) {
      build.onLoad({ filter: /[\\/]@napi-rs[\\/]keyring[\\/]index\.js$/ }, (args) => {
        // The addon of each platform is an optional package; only the one of this machine is installed.
        const platformDir = packageDir(target.keyringPackage, keyringDir);
        const file = path.join(platformDir, target.keyringFile);
        const sha256 = sha256File(file);
        const key = 'native/keyring.node';
        state.natives.push({ key, file, name: target.keyringFile, sha256 });
        return {
          contents: keyringIndexSource(key, sha256),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };

  const yogaPlugin: Plugin = {
    name: 'ot-yoga-preloaded',
    setup(build) {
      build.onResolve({ filter: /^yoga-layout$/ }, () => ({
        path: 'yoga-layout',
        namespace: 'ot-yoga',
      }));
      build.onResolve({ filter: /^yoga-layout\/load$/ }, () => ({
        path: path.join(yogaDir, 'dist', 'src', 'load.js'),
      }));
      build.onLoad({ filter: /.*/, namespace: 'ot-yoga' }, () => ({
        contents: yogaSource(path.join(yogaDir, 'dist', 'src', 'generated', 'YGEnums.js')),
        loader: 'js',
        resolveDir: yogaDir,
      }));
    },
  };

  const playwrightPlugin: Plugin = {
    name: 'ot-playwright-stub',
    setup(build) {
      build.onResolve({ filter: /^playwright-core$/ }, () => ({
        path: 'playwright-core',
        namespace: 'ot-playwright',
      }));
      build.onLoad({ filter: /.*/, namespace: 'ot-playwright' }, () => ({
        contents: PLAYWRIGHT_STUB_SOURCE,
        loader: 'js',
      }));
    },
  };

  const inkPlugin: Plugin = {
    name: 'ot-ink',
    setup(build) {
      // Ink starts React DevTools (and reads its own package.json) with a top-level `await` when
      // `process.env.DEV` is "true". The bundle has no DevTools: those two tests become `false`, and
      // esbuild drops what they guard. If a newer Ink words them differently, the build says so.
      build.onLoad(
        { filter: /[\\/]node_modules[\\/]ink[\\/]build[\\/]reconciler\.js$/ },
        (args) => {
          const text = readFileSync(args.path, 'utf8');
          const count = text.split(INK_DEV_TEST).length - 1;
          if (count === 0) {
            throw new Error(
              `Ink's reconciler no longer has ${INK_DEV_TEST}; update the ot-ink plugin`,
            );
          }
          return {
            contents: text.replaceAll(INK_DEV_TEST, 'false'),
            loader: 'js',
            resolveDir: path.dirname(args.path),
          };
        },
      );
      if (!options.patchInk) return;
      const patched = path.join(root, 'packages', 'tui', 'patches', 'ink', 'output.js');
      build.onLoad({ filter: /[\\/]node_modules[\\/]ink[\\/]build[\\/]output\.js$/ }, (args) => ({
        contents: readFileSync(patched, 'utf8'),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }));
    },
  };

  return [sqlitePlugin, keyringPlugin, yogaPlugin, playwrightPlugin, inkPlugin];
}
