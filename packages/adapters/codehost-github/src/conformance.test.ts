// SPDX-License-Identifier: MPL-2.0
import {
  describeCodeHostConformance,
  describeIssueTrackerConformance,
  disposeTestGitIsolation,
} from '@otheater/sdk';
import { afterAll } from 'vitest';
import { codeHostHarness, issueTrackerHarness } from './rig.fixture.js';

// The runner may kill its workers without an `exit`: remove the isolation folder of the fixtures.
afterAll(disposeTestGitIsolation);

// The real adapter, the real `git`, a real bare repository; only `gh` is a stand-in script.
describeCodeHostConformance('GithubCodeHost (fake gh)', () => codeHostHarness());
describeIssueTrackerConformance('GithubIssueTracker (fake gh)', () => issueTrackerHarness());
