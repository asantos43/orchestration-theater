// SPDX-License-Identifier: MPL-2.0
import { CODE_HOST_PORT_VERSION, isOTheaterError, type CodeHost } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface CodeHostHarness extends Disposable {
  readonly codeHost: CodeHost;
  /** Absolute path of a checkout of the repository the host serves. */
  readonly repo: string;
  /** The branch the remote starts with (the base of the pull requests), e.g. `main`. */
  readonly baseBranch: string;
  /**
   * Adds one commit to the local branch `branch`, creating it from the base when it does not
   * exist. Nothing is pushed. Returns the sha of the new commit.
   */
  readonly commit: (branch: string) => Promise<string>;
  /**
   * Rewrites the local branch `branch` (one that was pushed) so it no longer descends from what
   * the remote has: the next push of it is not a fast-forward. Returns the new local sha.
   */
  readonly diverge: (branch: string) => Promise<string>;
  /**
   * Creates the local branches `head` (from the base) and `baseBranch` (one commit ahead) so that
   * merging `head` into the base conflicts. Nothing is pushed.
   */
  readonly conflict: (head: string) => Promise<void>;
}

function codeOf(error: unknown): string | undefined {
  return isOTheaterError(error) ? error.code : undefined;
}

/** Ceiling of each test: the real adapter talks to git and to a host. */
const TEST_TIMEOUT_MS = 60_000;

/**
 * Registers the `CodeHost` conformance tests (port version {@link CODE_HOST_PORT_VERSION}) in the
 * calling Vitest file. The host is whatever the factory builds (the fake, the `gh` adapter against a
 * fake `gh` and a bare repository...); the suite never needs a real GitHub.
 */
export function describeCodeHostConformance(
  name: string,
  factory: AdapterFactory<CodeHostHarness>,
): void {
  describe(`CodeHost conformance: ${name} (port ${CODE_HOST_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    const pushed = async (branch: string): Promise<string> => {
      const { codeHost, repo, commit } = harness();
      await commit(branch);
      return codeHost.pushRef({ repo, branch });
    };

    describe('pushRef and remoteRef', () => {
      it(
        'pushRef puts the branch on the remote and returns its sha',
        async () => {
          const { codeHost, repo, commit } = harness();
          const sha = await commit('feature');
          expect(await codeHost.remoteRef({ repo, branch: 'feature' })).toBeUndefined();
          expect(await codeHost.pushRef({ repo, branch: 'feature' })).toBe(sha);
          expect(await codeHost.remoteRef({ repo, branch: 'feature' })).toBe(sha);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'pushing what the remote already has is a no-op that returns the same sha',
        async () => {
          const { codeHost, repo } = harness();
          const first = await pushed('feature');
          expect(await codeHost.pushRef({ repo, branch: 'feature' })).toBe(first);
          expect(await codeHost.remoteRef({ repo, branch: 'feature' })).toBe(first);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'pushRef fast-forwards a branch that moved ahead',
        async () => {
          const { codeHost, repo, commit } = harness();
          const first = await pushed('feature');
          const second = await commit('feature');
          expect(second).not.toBe(first);
          expect(await codeHost.pushRef({ repo, branch: 'feature' })).toBe(second);
          expect(await codeHost.remoteRef({ repo, branch: 'feature' })).toBe(second);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'pushRef never forces: a diverged branch rejects with Conflict and the remote stays as it was',
        async () => {
          const { codeHost, repo, diverge } = harness();
          const first = await pushed('feature');
          await diverge('feature');
          expect(codeOf(await rejectionOf(codeHost.pushRef({ repo, branch: 'feature' })))).toBe(
            'CONFLICT',
          );
          expect(await codeHost.remoteRef({ repo, branch: 'feature' })).toBe(first);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'pushRef of a branch that is not in the checkout rejects with NotFound',
        async () => {
          const { codeHost, repo } = harness();
          const error = await rejectionOf(codeHost.pushRef({ repo, branch: 'no-such-branch' }));
          expect(codeOf(error)).toBe('NOT_FOUND');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a branch name that is an option is InvalidInput',
        async () => {
          const { codeHost, repo } = harness();
          const error = await rejectionOf(codeHost.pushRef({ repo, branch: '--force' }));
          expect(codeOf(error)).toBe('INVALID_INPUT');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('pull requests', () => {
      it(
        'openPullRequest opens one PR that findPullRequest then finds',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          await pushed('feature');
          expect(
            await codeHost.findPullRequest({ repo, head: 'feature', base: baseBranch }),
          ).toBeUndefined();
          const pull = await codeHost.openPullRequest({
            repo,
            head: 'feature',
            base: baseBranch,
            title: 'The feature',
            body: 'What it does.',
          });
          expect(pull.state).toBe('open');
          expect(pull.headBranch).toBe('feature');
          expect(pull.baseBranch).toBe(baseBranch);
          expect(pull.title).toBe('The feature');
          expect(pull.draft).toBe(false);
          expect(pull.number).toBeGreaterThan(0);
          expect(pull.url).not.toBe('');
          expect(Number.isFinite(pull.createdAt)).toBe(true);
          const found = await codeHost.findPullRequest({ repo, head: 'feature' });
          expect(found?.number).toBe(pull.number);
          expect(found?.url).toBe(pull.url);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a second PR for the same head and base rejects with Conflict and leaves one PR',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          await pushed('feature');
          const first = await codeHost.openPullRequest({
            repo,
            head: 'feature',
            base: baseBranch,
            title: 'The feature',
            body: '',
          });
          const error = await rejectionOf(
            codeHost.openPullRequest({
              repo,
              head: 'feature',
              base: baseBranch,
              title: 'Again',
              body: '',
            }),
          );
          expect(codeOf(error)).toBe('CONFLICT');
          expect((await codeHost.findPullRequest({ repo, head: 'feature' }))?.number).toBe(
            first.number,
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'openPullRequest for a head that is not on the remote rejects with NotFound',
        async () => {
          const { codeHost, repo, baseBranch, commit } = harness();
          await commit('local-only');
          const error = await rejectionOf(
            codeHost.openPullRequest({
              repo,
              head: 'local-only',
              base: baseBranch,
              title: 'Nothing to open',
              body: '',
            }),
          );
          expect(codeOf(error)).toBe('NOT_FOUND');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'findPullRequest answers undefined for another base and for a branch with no PR',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          await pushed('feature');
          await codeHost.openPullRequest({
            repo,
            head: 'feature',
            base: baseBranch,
            title: 'The feature',
            body: '',
          });
          expect(
            await codeHost.findPullRequest({ repo, head: 'feature', base: 'other-base' }),
          ).toBeUndefined();
          expect(await codeHost.findPullRequest({ repo, head: 'unrelated' })).toBeUndefined();
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a draft PR is reported as a draft',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          await pushed('feature');
          const pull = await codeHost.openPullRequest({
            repo,
            head: 'feature',
            base: baseBranch,
            title: 'Wip',
            body: '',
            draft: true,
          });
          expect(pull.draft).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('mergeBranch and isBranchMerged', () => {
      it(
        'mergeBranch merges the head into the base on the remote',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          const head = await pushed('feature');
          expect(await codeHost.isBranchMerged({ repo, head: 'feature', base: baseBranch })).toBe(
            false,
          );
          const before = await codeHost.remoteRef({ repo, branch: baseBranch });
          const merged = await codeHost.mergeBranch({ repo, head: 'feature', base: baseBranch });
          expect(merged.sha).not.toBe(before);
          expect(await codeHost.remoteRef({ repo, branch: baseBranch })).toBe(merged.sha);
          expect(await codeHost.isBranchMerged({ repo, head: 'feature', base: baseBranch })).toBe(
            true,
          );
          expect(head).not.toBe('');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'merging what is already merged changes nothing',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          await pushed('feature');
          const first = await codeHost.mergeBranch({ repo, head: 'feature', base: baseBranch });
          const second = await codeHost.mergeBranch({ repo, head: 'feature', base: baseBranch });
          expect(second.sha).toBe(first.sha);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a conflict rejects with Conflict and the base stays as it was',
        async () => {
          const { codeHost, repo, baseBranch, conflict } = harness();
          await conflict('feature');
          await codeHost.pushRef({ repo, branch: baseBranch });
          await codeHost.pushRef({ repo, branch: 'feature' });
          const before = await codeHost.remoteRef({ repo, branch: baseBranch });
          const error = await rejectionOf(
            codeHost.mergeBranch({ repo, head: 'feature', base: baseBranch }),
          );
          expect(codeOf(error)).toBe('CONFLICT');
          expect(await codeHost.remoteRef({ repo, branch: baseBranch })).toBe(before);
          expect(await codeHost.isBranchMerged({ repo, head: 'feature', base: baseBranch })).toBe(
            false,
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a head that is not on the remote rejects with NotFound',
        async () => {
          const { codeHost, repo, baseBranch, commit } = harness();
          await commit('local-only');
          const error = await rejectionOf(
            codeHost.mergeBranch({ repo, head: 'local-only', base: baseBranch }),
          );
          expect(codeOf(error)).toBe('NOT_FOUND');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'the base is merged into itself',
        async () => {
          const { codeHost, repo, baseBranch } = harness();
          expect(await codeHost.isBranchMerged({ repo, head: baseBranch, base: baseBranch })).toBe(
            true,
          );
        },
        TEST_TIMEOUT_MS,
      );
    });
  });
}
