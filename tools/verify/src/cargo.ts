// SPDX-License-Identifier: MPL-2.0
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  compareStrings,
  isRecord,
  requireArray,
  requireString,
  UsageError,
  type ExecFn,
} from './common.js';
import type { LeveledPackage } from './pnpm.js';

/** Rust crates live in `native/<crate>/` (architecture 5.9); each one has its own `Cargo.lock`. */
export const NATIVE_DIR = 'native';

/** Crate directories (absolute) that have a committed `Cargo.lock`, sorted. Empty when there is no `native/`. */
export function findCargoLockDirs(root: string): string[] {
  const native = path.join(root, NATIVE_DIR);
  if (!existsSync(native)) return [];
  return readdirSync(native, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(native, e.name, 'Cargo.lock')))
    .map((e) => path.join(native, e.name))
    .sort(compareStrings);
}

/**
 * Parses `cargo metadata --format-version 1`. The crate itself (a workspace member) is not third-party and is skipped.
 * A missing `license` stays empty, which the classifier reports as "not identified". Old manifests may write
 * "MIT/Apache-2.0" for OR: cargo still accepts it, so it is read as OR.
 * `path` is the lock file (repository-relative locations only: the registry cache path has the user's home in it).
 */
export function parseCargoMetadata(stdout: string, lockFile: string): LeveledPackage[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new UsageError('unexpected output from "cargo metadata": not JSON');
  }
  if (!isRecord(json))
    throw new UsageError('unexpected output from "cargo metadata": not an object');
  const members = new Set(requireArray(json.workspace_members, 'cargo metadata.workspace_members'));
  const packages: LeveledPackage[] = [];
  for (const [i, entry] of requireArray(json.packages, 'cargo metadata.packages').entries()) {
    const at = `cargo metadata.packages[${String(i)}]`;
    if (!isRecord(entry)) throw new UsageError(`${at}: expected an object`);
    if (members.has(entry.id)) continue;
    const declared = entry.license;
    packages.push({
      name: requireString(entry, 'name', at),
      version: requireString(entry, 'version', at),
      license: typeof declared === 'string' ? declared.replaceAll('/', ' OR ') : '',
      path: lockFile,
      // A crate in the lock is linked into the binary: level B (bundled).
      level: 'B',
    });
  }
  return packages;
}

/** Third-party crates of every `native/*` crate that has a `Cargo.lock`, read offline from the locked graph. */
export async function collectCargoPackages(exec: ExecFn, root: string): Promise<LeveledPackage[]> {
  const result: LeveledPackage[] = [];
  for (const dir of findCargoLockDirs(root)) {
    let stdout: string;
    try {
      stdout = await exec('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], {
        cwd: dir,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const hint = detail.includes('ENOENT')
        ? '"cargo" is not on PATH: install the Rust toolchain (rustup) to verify the crates in native/'
        : `run "cargo fetch --locked" in ${path.relative(root, dir)} first (the check is offline)`;
      throw new UsageError(
        `cargo metadata failed in ${path.relative(root, dir)}: ${hint}. ${detail}`,
      );
    }
    result.push(...parseCargoMetadata(stdout, path.join(dir, 'Cargo.lock')));
  }
  return result;
}
