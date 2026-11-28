// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import type { WorkflowPackageOrigin } from '@otheater/protocol';
import type { Env } from '../../paths.js';
import { fetchGit, type CommandRunner } from '../../plugins/sources.js';

/**
 * A workflow package from a git repository, pinned to a commit (N298; plan of Phase 11b, P9). It
 * reuses the clone of the plugins (`plugins/sources.ts`): no hook runs, no helper, no password
 * prompt, no system or user configuration, and the `.git` folder is deleted, so what is left is
 * the files of one commit. On top of it:
 *
 * - the ref the Producer wrote (a branch, a tag or a commit) is resolved to the full commit at
 *   the moment of the install and that commit is what is recorded (`origin.commit`): the package
 *   never follows the branch again, so a ref that moves at the remote changes nothing that is
 *   installed; an update is a new install, which resolves the ref again and shows its permissions
 *   again;
 * - a ref that is a full commit must resolve to exactly that commit.
 */

export interface GitPackageSpec {
  readonly url: string;
  /** `undefined` is the default branch (`HEAD`). */
  readonly ref: string | undefined;
}

export interface FetchedPackage {
  /** The folder with the files of the commit; the caller deletes the staging folder it was made in. */
  readonly root: string;
  readonly origin: Extract<WorkflowPackageOrigin, { kind: 'git' }>;
}

export interface GitFetchContext {
  readonly runner: CommandRunner;
  readonly env: Env;
  readonly timeoutMs: number;
  /** An empty folder the clone may use; the caller deletes it. */
  readonly stage: string;
}

const FULL_COMMIT = /^[0-9a-f]{40,64}$/;

export async function fetchPackageFromGit(
  spec: GitPackageSpec,
  context: GitFetchContext,
): Promise<FetchedPackage> {
  const fetched = await fetchGit({ url: spec.url, ref: spec.ref }, context);
  if (fetched.origin.kind !== 'git') {
    throw new InvalidInput('the clone did not give a git origin');
  }
  const { url, ref, commit } = fetched.origin;
  if (spec.ref !== undefined && FULL_COMMIT.test(spec.ref) && commit !== spec.ref) {
    throw new InvalidInput(`the ref ${spec.ref} resolved to another commit (${commit})`);
  }
  return { root: fetched.root, origin: { kind: 'git', url, ref, commit } };
}
