// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the workspace only (excluded from the build of the package).
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attemptBranch,
  type CodeHost,
  type Demand,
  type Script,
  type Store,
  type Vcs,
} from '@otheater/core';
import { testGit } from '@otheater/sdk';
import { defaultVcs } from '../compose.js';
import { Workspace } from './workspace.js';

/** A demand that is ready for the topological order; only the ids and the edges matter here. */
export function demandOf(id: string, dependsOn: string[] = []): Demand {
  return {
    id,
    title: `Demand ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    contract: { inputs: [], outputs: [`c-${id}`] },
    expectedFiles: [`${id}.txt`],
    complexity: 'low',
    timeoutMin: 20,
    acceptanceCriteria: [`${id} works`],
    verify: [{ name: 'tests', command: 'pnpm', args: ['vitest', 'run', id] }],
  };
}

export function scriptOf(demands: Demand[]): Pick<Script, 'demands'> {
  return { demands };
}

export interface WorkspaceRig {
  /** The working repository (`origin` is the bare repository). */
  readonly repo: string;
  /** A bare repository in a temporary folder, the "remote". */
  readonly remote: string;
  readonly worktreeRoot: string;
  readonly vcs: Vcs;
  readonly workspace: Workspace;
  /**
   * Makes the branch of an attempt the way an attempt does: a worktree from the play base, the
   * `files` written and committed. The worktree goes away, the branch stays. Returns its head.
   */
  attempt(
    playId: string,
    demandId: string,
    attempt: number,
    files: Record<string, string>,
  ): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * A real git repository with a bare repository as `origin` (both in a temporary folder) and a
 * `Workspace` over the real `GitVcs`. The code host and the store are the test's (the fixture
 * cannot import the fakes of `@otheater/core/testing` itself).
 */
export async function makeWorkspaceRig(parts: {
  readonly store: Pick<Store, 'events' | 'sideEffects'>;
  readonly codeHost: CodeHost;
}): Promise<WorkspaceRig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-workspace-')));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const worktreeRoot = join(root, 'worktrees');
  await testGit(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  await testGit(root, 'init', '--quiet', '--initial-branch=main', repo);
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
  await testGit(repo, 'remote', 'add', 'origin', remote);
  await testGit(repo, 'push', '--quiet', 'origin', 'main');

  const vcs = defaultVcs();
  const workspace = new Workspace({ ...parts, vcs, worktreeRoot });
  return {
    repo,
    remote,
    worktreeRoot,
    vcs,
    workspace,
    async attempt(playId, demandId, attemptNumber, files) {
      const branch = attemptBranch(playId, demandId, attemptNumber);
      const path = join(worktreeRoot, 'attempts', playId, `${demandId}-${String(attemptNumber)}`);
      await vcs.createWorktree({
        repo,
        path,
        branch,
        base: `play/${playId}/base`,
      });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(path, name), content);
      }
      await vcs.commitAll(path, `Work of ${demandId}`);
      const head = await vcs.headOf(path);
      await vcs.removeWorktree(path);
      return head;
    },
    async dispose() {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
