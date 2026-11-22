// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the repository: `tools/release/{src,dist}/` sits three folders below it. */
export function repoRoot(from: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(from)), '../../..');
}

/**
 * The folder of the package `name` as `fromDir` resolves it (pnpm keeps each package where only its
 * dependents see it, so the folder of the one that uses it is the starting point). Not every package
 * exports its `package.json`, so the folder is found from the main file, walking up to the manifest
 * that names the package.
 */
export function packageDir(name: string, fromDir: string): string {
  const require = createRequire(path.join(fromDir, 'noop.js'));
  let main: string;
  try {
    main = require.resolve(name);
  } catch (cause) {
    throw new Error(
      `Cannot find the package ${name} from ${fromDir}: ${(cause as Error).message}`,
      {
        cause,
      },
    );
  }
  let dir = path.dirname(realpathSync(main));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && readJson(manifest).name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`Cannot find the folder of the package ${name} (from ${main})`);
    dir = parent;
  }
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** The `version` of the package.json in `dir`. */
export function packageVersion(dir: string): string {
  const version = readJson(path.join(dir, 'package.json')).version;
  if (typeof version !== 'string') throw new Error(`${dir}/package.json has no version`);
  return version;
}

/** Throws when a file the build needs is not there (the packages are compiled before the bundle). */
export function requireFile(file: string, what: string): string {
  if (!existsSync(file)) {
    throw new Error(`${what} not found at ${file}; run "pnpm -s build" first`);
  }
  return file;
}
