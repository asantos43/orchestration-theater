// SPDX-License-Identifier: MPL-2.0
import { FakeIssueTracker } from '@otheater/core/testing';
import { describeIssueTrackerConformance } from '../index.js';

// The fake of `@otheater/core/testing` must pass the suite: it is what the workflow tests use.

describeIssueTrackerConformance('FakeIssueTracker', () => {
  // Each seed is one ms newer than the one before, so the order of `listIssues` is known.
  let now = 1_000_000;
  const issueTracker = new FakeIssueTracker({ clock: { now: () => (now += 1) } });
  return {
    issueTracker,
    repo: '/repo/fake',
    seedIssue: (issue) => Promise.resolve(issueTracker.seedIssue(issue).number),
    seedPullRequest: () => Promise.resolve(issueTracker.seedPullRequest()),
  };
});
