// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, type CodeHost } from '@otheater/core';
import { FakeCodeHost, FakeIssueTracker } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { NoIssueTracker, SameHostIssueTracker } from './issue-tracker.js';

const REPO = '/work/repo';

describe('NoIssueTracker', () => {
  it('refuses every call with AdapterUnavailable, naming the repository and the reason', async () => {
    const tracker = new NoIssueTracker((repo) => `no tracker here (${repo})`);
    const calls = [
      tracker.fetchIssue({ repo: REPO, number: 1 }),
      tracker.listIssues({ repo: REPO }),
      tracker.commentOnIssue({ repo: REPO, number: 1, body: 'x' }),
      tracker.commentOnPullRequest({ repo: REPO, number: 1, body: 'x' }),
      tracker.addLabels({ repo: REPO, number: 1, labels: ['bug'] }),
      tracker.removeLabels({ repo: REPO, number: 1, labels: ['bug'] }),
    ];
    for (const call of calls) {
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AdapterUnavailable);
      expect(String(error)).toContain(`There is no issue tracker for ${REPO}: no tracker here`);
    }
  });

  it('says adapters.issue_tracker is none by default', async () => {
    await expect(new NoIssueTracker().listIssues({ repo: REPO })).rejects.toThrow(
      'adapters.issue_tracker is none',
    );
  });
});

describe('SameHostIssueTracker', () => {
  function build(answer: 'github' | 'other', withGithub = true) {
    const githubHost = new FakeCodeHost() as CodeHost;
    const otherHost = new FakeCodeHost() as CodeHost;
    const github = new FakeIssueTracker();
    const asked: [string, string][] = [];
    const tracker = new SameHostIssueTracker({
      hostFor: (repo, remote) => {
        asked.push([repo, remote]);
        return Promise.resolve(answer === 'github' ? githubHost : otherHost);
      },
      githubHost: withGithub ? githubHost : undefined,
      github: withGithub ? github : undefined,
      none: new NoIssueTracker(() => 'not GitHub'),
    });
    return { tracker, github, asked };
  }

  it('uses the GitHub tracker where the code host of the repository is GitHub', async () => {
    const { tracker, github, asked } = build('github');
    const number = github.seedIssue({ title: 'An issue' }).number;
    expect((await tracker.fetchIssue({ repo: REPO, number })).title).toBe('An issue');
    await tracker.addLabels({ repo: REPO, number, labels: ['bug'], remote: 'upstream' });
    expect(github.labelsOf(number)).toEqual(['bug']);
    expect(asked).toEqual([
      [REPO, 'origin'],
      [REPO, 'upstream'],
    ]);
  });

  it('has no tracker where the code host is another one, or when GitHub was not built', async () => {
    for (const { tracker } of [build('other'), build('github', false)]) {
      await expect(tracker.listIssues({ repo: REPO })).rejects.toThrow('not GitHub');
    }
    // Without GitHub there is nothing to ask.
    const { tracker, asked } = build('github', false);
    await tracker.listIssues({ repo: REPO }).catch(() => undefined);
    expect(asked).toEqual([]);
  });
});
