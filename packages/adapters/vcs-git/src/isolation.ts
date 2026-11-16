// SPDX-License-Identifier: MPL-2.0
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';

/**
 * Real, empty, read-only stand-ins for "no configuration" (architecture 5.5). The null device
 * (`os.devNull`) is not used: on Windows it is `\\.\nul`, which Git for Windows rejects as a file
 * or directory path (`unable to access '\\.\nul'`). An empty directory behaves the same on every
 * platform, so there is a single code path.
 */
export interface GitIsolation {
  /** The directory that holds the three entries below. */
  readonly root: string;
  /** An empty file: `GIT_CONFIG_GLOBAL`. */
  readonly configFile: string;
  /** An empty directory: `HOME` and `XDG_CONFIG_HOME`. */
  readonly homeDir: string;
  /** An empty directory: `core.hooksPath`. */
  readonly hooksDir: string;
}

const PREFIX = 'otheater-git-';

const cache = new Map<string, GitIsolation>();
let exitHookInstalled = false;

/**
 * Builds an isolation directory under `parent` (a fresh `otheater-git-XXXXXX` folder): an empty
 * `gitconfig` (mode 0o444) and empty `home` and `hooks` folders (mode 0o555), so nothing can be
 * written there. Synchronous: it runs once. The caller owns the removal ({@link removeGitIsolation}).
 * Fails `AdapterUnavailable` when the folder cannot be created.
 */
export function createGitIsolation(parent: string = tmpdir()): GitIsolation {
  try {
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(resolve(parent), PREFIX));
    const isolation: GitIsolation = {
      root,
      configFile: join(root, 'gitconfig'),
      homeDir: join(root, 'home'),
      hooksDir: join(root, 'hooks'),
    };
    writeFileSync(isolation.configFile, '');
    mkdirSync(isolation.homeDir);
    mkdirSync(isolation.hooksDir);
    chmodSync(isolation.configFile, 0o444);
    chmodSync(isolation.homeDir, 0o555);
    chmodSync(isolation.hooksDir, 0o555);
    return isolation;
  } catch (error) {
    throw new AdapterUnavailable(
      `Cannot create the git isolation directory under ${parent}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/** Removes an isolation directory, restoring write permission first. Never throws. */
export function removeGitIsolation(isolation: GitIsolation): void {
  try {
    chmodSync(isolation.homeDir, 0o755);
    chmodSync(isolation.hooksDir, 0o755);
    chmodSync(isolation.configFile, 0o644);
  } catch {
    // Already gone, or the platform ignores the mode: the removal below decides.
  }
  try {
    rmSync(isolation.root, { recursive: true, force: true });
  } catch {
    // Best effort at process exit; the folder is empty and lives in a temporary directory.
  }
}

/**
 * The isolation of this process under `parent` (default: the system temporary directory), created
 * on first use and removed when the process exits. One per parent directory.
 */
export function sharedGitIsolation(parent: string = tmpdir()): GitIsolation {
  const key = resolve(parent);
  const known = cache.get(key);
  if (known !== undefined) return known;
  const created = createGitIsolation(key);
  cache.set(key, created);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', disposeSharedGitIsolations);
  }
  return created;
}

/**
 * Removes every shared isolation of this process now (the next use builds a new one). Runs by
 * itself at process exit; tests call it when the runner kills its workers without an `exit`.
 */
export function disposeSharedGitIsolations(): void {
  for (const isolation of cache.values()) removeGitIsolation(isolation);
  cache.clear();
}
