// SPDX-License-Identifier: MPL-2.0
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real, empty, read-only stand-ins for "no git configuration" for the fixtures of the Vcs suite.
 * The null device (`os.devNull`) cannot be used: on Windows it is `\\.\nul`, which Git for Windows
 * rejects as a file or directory path. The adapter has the same helper (`isolation.ts` of
 * `adapter-vcs-git`); the SDK cannot import an adapter, so this is a small local copy.
 */
export interface TestGitIsolation {
  readonly configFile: string;
  readonly homeDir: string;
  readonly hooksDir: string;
}

interface Shared extends TestGitIsolation {
  readonly root: string;
}

let shared: Shared | undefined;
let exitHookInstalled = false;

/** Created on first use, once per process, and removed when the process exits. */
export function testGitIsolation(): TestGitIsolation {
  if (shared !== undefined) return shared;
  const root = mkdtempSync(join(tmpdir(), 'otheater-git-conf-'));
  const created: Shared = {
    root,
    configFile: join(root, 'gitconfig'),
    homeDir: join(root, 'home'),
    hooksDir: join(root, 'hooks'),
  };
  writeFileSync(created.configFile, '');
  mkdirSync(created.homeDir);
  mkdirSync(created.hooksDir);
  chmodSync(created.configFile, 0o444);
  chmodSync(created.homeDir, 0o555);
  chmodSync(created.hooksDir, 0o555);
  shared = created;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', disposeTestGitIsolation);
  }
  return created;
}

/**
 * Removes the isolation now (the next `testGit` builds a new one). Runs by itself at process exit;
 * tests call it from `afterAll` because a test runner may kill its workers without an `exit`.
 */
export function disposeTestGitIsolation(): void {
  const current = shared;
  if (current === undefined) return;
  shared = undefined;
  try {
    chmodSync(current.homeDir, 0o755);
    chmodSync(current.hooksDir, 0o755);
    chmodSync(current.configFile, 0o644);
  } catch {
    // Already gone: the removal below decides.
  }
  rmSync(current.root, { recursive: true, force: true });
}
