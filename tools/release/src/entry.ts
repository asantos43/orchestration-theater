// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';

/** The files of the compiled packages the entry of the executable imports. */
export interface EntryFiles {
  /** `packages/daemon/dist/sea/main.js`: `runSeaMain`. */
  readonly seaMain: string;
  /** `packages/client/dist/node/sea.js`: `loadSeaNative`. */
  readonly seaNative: string;
  /** `packages/tui/dist/run-main.js`: `runTuiMain`. */
  readonly tuiMain: string;
}

export function entryFiles(root: string): EntryFiles {
  return {
    seaMain: path.join(root, 'packages', 'daemon', 'dist', 'sea', 'main.js'),
    seaNative: path.join(root, 'packages', 'client', 'dist', 'node', 'sea.js'),
    tuiMain: path.join(root, 'packages', 'tui', 'dist', 'run-main.js'),
  };
}

/**
 * The entry of the bundle, as text. It is generated, and not a file of a package, for the layering: the
 * daemon may import the TUI only through the launcher, so the one place that wires `runSeaMain` to
 * `runTuiMain` is the build. Everything is a function call (a CommonJS file has no top-level `await`):
 *
 * 1. `globalThis.__otSeaNative` is what the replaced loaders of the native addons call;
 * 2. the TUI handler starts yoga first (`globalThis.__otYoga`, the module that stands for
 *    `yoga-layout` reads it) and only then imports the TUI, which pulls Ink and yoga in;
 * 3. `verify-release` and `apply-update` have no handler: the runner answers "not available".
 */
export function entrySource(files: EntryFiles): string {
  const q = (file: string): string => JSON.stringify(file);
  return `import { runSeaMain } from ${q(files.seaMain)};
import { loadSeaNative } from ${q(files.seaNative)};
import { loadYoga } from 'yoga-layout/load';

globalThis.__otSeaNative = { load: loadSeaNative };

runSeaMain(process.argv.slice(2), {
  tui: async (argv) => {
    globalThis.__otYoga = await loadYoga();
    const { runTuiMain } = await import(${q(files.tuiMain)});
    await runTuiMain(argv);
  },
}).catch((error) => {
  process.stderr.write(\`otheater: \${error instanceof Error ? (error.stack ?? error.message) : String(error)}\\n\`);
  process.exitCode = 1;
});
`;
}
