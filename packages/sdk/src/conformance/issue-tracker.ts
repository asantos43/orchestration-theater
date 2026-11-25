// SPDX-License-Identifier: MPL-2.0
import {
  isOTheaterError,
  ISSUE_LIST_MAX,
  ISSUE_TRACKER_PORT_VERSION,
  type IssueState,
  type IssueTracker,
} from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

/** An issue the suite puts on the tracker. */
export interface IssueSeed {
  readonly title: string;
  readonly body?: string;
  /** Default `open`. */
  readonly state?: IssueState;
  readonly labels?: readonly string[];
}

export interface IssueTrackerHarness extends Disposable {
  readonly issueTracker: IssueTracker;
  /** Absolute path of a checkout of the repository the tracker serves. */
  readonly repo: string;
  /**
   * Opens an issue on the tracker and returns its number. Each one is newer than the ones seeded
   * before it (the suite checks the order of `listIssues`).
   */
  readonly seedIssue: (issue: IssueSeed) => Promise<number>;
  /** Opens a pull request (any head) and returns its number, from the same numbering as issues. */
  readonly seedPullRequest: () => Promise<number>;
}

function codeOf(error: unknown): string | undefined {
  return isOTheaterError(error) ? error.code : undefined;
}

/** Ceiling of each test: the real adapter talks to a tool and to a host. */
const TEST_TIMEOUT_MS = 60_000;

/**
 * Registers the `IssueTracker` conformance tests (port version {@link ISSUE_TRACKER_PORT_VERSION})
 * in the calling Vitest file. The tracker is whatever the factory builds (the fake, the `gh`
 * adapter against a fake `gh`...); the suite never needs a real GitHub.
 */
export function describeIssueTrackerConformance(
  name: string,
  factory: AdapterFactory<IssueTrackerHarness>,
): void {
  describe(`IssueTracker conformance: ${name} (port ${ISSUE_TRACKER_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    describe('fetchIssue', () => {
      it(
        'returns the issue with its title, body, state, sorted labels and author',
        async () => {
          const { issueTracker, repo, seedIssue } = harness();
          const number = await seedIssue({
            title: 'It breaks',
            body: 'Steps to see it.',
            labels: ['bug', 'area-ui'],
          });
          const issue = await issueTracker.fetchIssue({ repo, number });
          expect(issue.number).toBe(number);
          expect(issue.title).toBe('It breaks');
          expect(issue.body).toBe('Steps to see it.');
          expect(issue.state).toBe('open');
          expect(issue.labels).toEqual(['area-ui', 'bug']);
          expect(issue.author).not.toBe('');
          expect(issue.url).not.toBe('');
          expect(Number.isFinite(issue.createdAt)).toBe(true);
          expect(issue.updatedAt).toBeGreaterThanOrEqual(issue.createdAt);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a pull request or an absent number is NotFound; a bad number is InvalidInput',
        async () => {
          const { issueTracker, repo, seedPullRequest } = harness();
          const pull = await seedPullRequest();
          expect(codeOf(await rejectionOf(issueTracker.fetchIssue({ repo, number: pull })))).toBe(
            'NOT_FOUND',
          );
          expect(codeOf(await rejectionOf(issueTracker.fetchIssue({ repo, number: 999 })))).toBe(
            'NOT_FOUND',
          );
          expect(codeOf(await rejectionOf(issueTracker.fetchIssue({ repo, number: 0 })))).toBe(
            'INVALID_INPUT',
          );
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('listIssues', () => {
      const seeded = async (): Promise<{ open1: number; closed: number; open2: number }> => {
        const { seedIssue, seedPullRequest } = harness();
        const open1 = await seedIssue({ title: 'first', labels: ['bug'] });
        const closed = await seedIssue({ title: 'second', state: 'closed', labels: ['bug'] });
        await seedPullRequest();
        const open2 = await seedIssue({ title: 'third', labels: ['bug', 'urgent'] });
        return { open1, closed, open2 };
      };

      it(
        'returns the open issues by default, newest first, and never a pull request',
        async () => {
          const { issueTracker, repo } = harness();
          const { open1, open2 } = await seeded();
          const list = await issueTracker.listIssues({ repo });
          expect(list.map((issue) => issue.number)).toEqual([open2, open1]);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'filters by state, by every label, by author, by time and caps at limit',
        async () => {
          const { issueTracker, repo } = harness();
          const { open1, closed, open2 } = await seeded();
          const numbers = async (
            opts: Omit<Parameters<IssueTracker['listIssues']>[0], 'repo'>,
          ): Promise<number[]> =>
            (await issueTracker.listIssues({ repo, ...opts })).map((issue) => issue.number);
          expect(await numbers({ state: 'closed' })).toEqual([closed]);
          expect(await numbers({ state: 'all' })).toEqual([open2, closed, open1]);
          expect(await numbers({ labels: ['bug', 'urgent'] })).toEqual([open2]);
          expect(await numbers({ state: 'all', limit: 2 })).toEqual([open2, closed]);
          const author = (await issueTracker.fetchIssue({ repo, number: open1 })).author;
          expect(await numbers({ author })).toEqual([open2, open1]);
          expect(await numbers({ author: 'nobody-of-this-suite' })).toEqual([]);
          expect(await numbers({ since: 0 })).toEqual([open2, open1]);
          expect(await numbers({ since: Date.now() + 24 * 60 * 60 * 1000 })).toEqual([]);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        `a limit out of 1 to ${String(ISSUE_LIST_MAX)} is InvalidInput`,
        async () => {
          const { issueTracker, repo } = harness();
          for (const limit of [0, ISSUE_LIST_MAX + 1, 1.5]) {
            expect(codeOf(await rejectionOf(issueTracker.listIssues({ repo, limit })))).toBe(
              'INVALID_INPUT',
            );
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('comments', () => {
      it(
        'commentOnIssue and commentOnPullRequest each add a comment and return it',
        async () => {
          const { issueTracker, repo, seedIssue, seedPullRequest } = harness();
          const issue = await seedIssue({ title: 'An issue' });
          const pull = await seedPullRequest();
          const onIssue = await issueTracker.commentOnIssue({ repo, number: issue, body: 'Seen.' });
          const onPull = await issueTracker.commentOnPullRequest({
            repo,
            number: pull,
            body: 'Looks good.',
          });
          for (const comment of [onIssue, onPull]) {
            expect(comment.id).not.toBe('');
            expect(comment.url).not.toBe('');
            expect(Number.isFinite(comment.createdAt)).toBe(true);
          }
          expect(onIssue.id).not.toBe(onPull.id);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a number of the other kind is NotFound, and an empty body is InvalidInput',
        async () => {
          const { issueTracker, repo, seedIssue, seedPullRequest } = harness();
          const issue = await seedIssue({ title: 'An issue' });
          const pull = await seedPullRequest();
          expect(
            codeOf(
              await rejectionOf(issueTracker.commentOnIssue({ repo, number: pull, body: 'x' })),
            ),
          ).toBe('NOT_FOUND');
          expect(
            codeOf(
              await rejectionOf(
                issueTracker.commentOnPullRequest({ repo, number: issue, body: 'x' }),
              ),
            ),
          ).toBe('NOT_FOUND');
          expect(
            codeOf(
              await rejectionOf(issueTracker.commentOnIssue({ repo, number: issue, body: ' ' })),
            ),
          ).toBe('INVALID_INPUT');
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe('labels', () => {
      it(
        'addLabels and removeLabels return the labels the item has afterwards, sorted',
        async () => {
          const { issueTracker, repo, seedIssue } = harness();
          const number = await seedIssue({ title: 'An issue', labels: ['bug'] });
          expect(
            await issueTracker.addLabels({ repo, number, labels: ['urgent', 'area-ui'] }),
          ).toEqual(['area-ui', 'bug', 'urgent']);
          // Adding one it has, or removing one it lacks, is a no-op.
          expect(await issueTracker.addLabels({ repo, number, labels: ['bug'] })).toEqual([
            'area-ui',
            'bug',
            'urgent',
          ]);
          expect(
            await issueTracker.removeLabels({ repo, number, labels: ['bug', 'never-there'] }),
          ).toEqual(['area-ui', 'urgent']);
          expect((await issueTracker.fetchIssue({ repo, number })).labels).toEqual([
            'area-ui',
            'urgent',
          ]);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'labels work on pull requests too',
        async () => {
          const { issueTracker, repo, seedPullRequest } = harness();
          const number = await seedPullRequest();
          expect(await issueTracker.addLabels({ repo, number, labels: ['ot:ready'] })).toEqual([
            'ot:ready',
          ]);
          expect(await issueTracker.removeLabels({ repo, number, labels: ['ot:ready'] })).toEqual(
            [],
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'a bad label or an empty list is InvalidInput; an absent number is NotFound',
        async () => {
          const { issueTracker, repo, seedIssue } = harness();
          const number = await seedIssue({ title: 'An issue' });
          for (const labels of [[], [''], ['a,b'], ['two\nlines']]) {
            expect(
              codeOf(await rejectionOf(issueTracker.addLabels({ repo, number, labels }))),
            ).toBe('INVALID_INPUT');
          }
          expect(
            codeOf(await rejectionOf(issueTracker.addLabels({ repo, number: 999, labels: ['x'] }))),
          ).toBe('NOT_FOUND');
          expect(
            codeOf(
              await rejectionOf(issueTracker.removeLabels({ repo, number: 999, labels: ['x'] })),
            ),
          ).toBe('NOT_FOUND');
        },
        TEST_TIMEOUT_MS,
      );
    });
  });
}
