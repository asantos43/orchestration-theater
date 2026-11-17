// SPDX-License-Identifier: MPL-2.0
import { FakeCodeHost } from '@otheater/core/testing';
import { describeCodeHostConformance } from '../index.js';

// The fake of `@otheater/core/testing` must pass the suite: it is what the Workspace tests use.

const REPO = '/repo/fake';
const BASE = 'main';

describeCodeHostConformance('FakeCodeHost', () => {
  const codeHost = new FakeCodeHost();
  codeHost.seedRemote(REPO, BASE);
  return {
    codeHost,
    repo: REPO,
    baseBranch: BASE,
    commit: (branch) => {
      if (codeHost.localSha(REPO, branch) === undefined) {
        // A new branch starts at the base, as `git switch -c` would.
        const base = codeHost.localSha(REPO, BASE);
        if (base !== undefined) return Promise.resolve(codeHost.commitLocal(REPO, branch, base));
      }
      return Promise.resolve(codeHost.commitLocal(REPO, branch));
    },
    diverge: (branch) => {
      // A commit on a made-up root, which has nothing in common with what the remote has.
      const orphan = codeHost.seedLocalRoot(REPO, branch);
      return Promise.resolve(orphan);
    },
    conflict: (head) => {
      const base = codeHost.localSha(REPO, BASE);
      if (base === undefined) throw new Error('The fake has no base');
      codeHost.commitLocal(REPO, head, base);
      codeHost.commitLocal(REPO, BASE);
      codeHost.conflictBetween(REPO, head, BASE);
      return Promise.resolve();
    },
  };
});
