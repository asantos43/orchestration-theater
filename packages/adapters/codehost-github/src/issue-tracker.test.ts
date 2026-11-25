// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isOTheaterError } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { GITHUB_ISSUE_TRACKER_ADAPTER, issueOf, parseRuns, pullDetails } from './index.js';
import { makeGithubRig, type GithubRig } from './rig.fixture.js';

afterAll(disposeTestGitIsolation);

const TEST_TIMEOUT_MS = 60_000;

function codeOf(error: unknown): string | undefined {
  return isOTheaterError(error) ? error.code : undefined;
}

function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const issueJson = {
  number: 7,
  html_url: 'https://github.invalid/o/r/issues/7',
  title: 't',
  body: null,
  state: 'OPEN',
  labels: [{ name: 'b' }, { name: 'a' }, { name: 'a' }],
  user: null,
  created_at: '2026-11-25T12:00:00Z',
  updated_at: '2026-11-25T13:00:00Z',
};

describe('parsers', () => {
  it('declares the IssueTracker port', () => {
    expect(GITHUB_ISSUE_TRACKER_ADAPTER.implements.port).toBe('IssueTracker');
  });

  it('issueOf fills a null body and a deleted author, and sorts the labels', () => {
    expect(issueOf(issueJson)).toEqual({
      number: 7,
      url: 'https://github.invalid/o/r/issues/7',
      title: 't',
      body: '',
      state: 'open',
      labels: ['a', 'b'],
      author: 'ghost',
      createdAt: Date.parse('2026-11-25T12:00:00Z'),
      updatedAt: Date.parse('2026-11-25T13:00:00Z'),
    });
  });

  it('issueOf rejects an unknown state or a bad date as unavailable', () => {
    expect(codeOf(catching(() => issueOf({ ...issueJson, state: 'locked' })))).toBe(
      'ADAPTER_UNAVAILABLE',
    );
    expect(codeOf(catching(() => issueOf({ ...issueJson, created_at: 'soon' })))).toBe(
      'ADAPTER_UNAVAILABLE',
    );
  });

  it('pullDetails reads a merged pull request', () => {
    const details = pullDetails({
      number: 3,
      html_url: 'u',
      state: 'closed',
      merged_at: '2026-11-25T12:00:00Z',
      title: 't',
      created_at: '2026-11-25T11:00:00Z',
      user: { login: 'someone' },
      labels: [],
      head: { ref: 'feature', sha: 'abc' },
      base: { ref: 'main' },
    });
    expect(details).toMatchObject({
      state: 'merged',
      draft: false,
      body: '',
      author: 'someone',
      headSha: 'abc',
      headBranch: 'feature',
      baseBranch: 'main',
    });
  });

  it('parseRuns sorts oldest first and maps the waiting statuses to queued', () => {
    const run = (id: number, at: string, status: string, conclusion: string | null) => ({
      id,
      name: `r${String(id)}`,
      status,
      conclusion,
      html_url: `u${String(id)}`,
      created_at: at,
    });
    const runs = parseRuns({
      workflow_runs: [
        run(3, '2026-11-25T12:00:02Z', 'completed', 'failure'),
        run(2, '2026-11-25T12:00:01Z', 'waiting', 'neutral'),
        run(1, '2026-11-25T12:00:01Z', 'in_progress', null),
      ],
    });
    expect(runs.map((r) => [r.id, r.status, r.conclusion])).toEqual([
      ['1', 'in_progress', null],
      ['2', 'queued', null],
      ['3', 'completed', 'failure'],
    ]);
  });
});

describe('GithubIssueTracker against a fake gh', () => {
  let rig: GithubRig | undefined;
  afterEach(async () => {
    await rig?.dispose();
    rig = undefined;
  });

  const apiCalls = async (current: GithubRig): Promise<string[][]> =>
    (await current.ghCalls()).filter((call) => call.args[0] === 'api').map((call) => call.args);

  it(
    'listIssues sends the filters to the API and reads further pages past the pull requests',
    async () => {
      rig = await makeGithubRig();
      const older = await rig.seedIssue({ title: 'older', labels: ['bug'] });
      const newer = await rig.seedIssue({ title: 'newer', labels: ['bug'] });
      // A full first page of pull requests, all newer than the issues.
      const file = join(rig.root, 'gh', 'prs.json');
      const pulls = Array.from({ length: 100 }, (_, index) => ({
        number: 10 + index,
        url: `https://github.invalid/o/r/pull/${String(10 + index)}`,
        state: 'OPEN',
        headRefName: `h${String(index)}`,
        baseRefName: 'main',
        title: 'p',
        isDraft: false,
        createdAt: new Date(Date.now() + 60_000 + index).toISOString(),
        labels: ['bug'],
      }));
      await writeFile(file, JSON.stringify(pulls));
      const since = Date.parse('2026-01-01T00:00:00Z');
      const list = await rig.issueTracker.listIssues({
        repo: rig.repo,
        labels: ['bug'],
        author: 'fake-user',
        since,
        limit: 5,
      });
      expect(list.map((issue) => issue.number)).toEqual([newer, older]);
      const calls = await apiCalls(rig);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(
        expect.arrayContaining([
          'labels=bug',
          'creator=fake-user',
          `since=${new Date(since).toISOString()}`,
          'per_page=100',
          'page=1',
        ]),
      );
      expect(calls[1]).toContain('page=2');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removeLabels deletes only the labels the item has, with the name encoded',
    async () => {
      rig = await makeGithubRig();
      const number = await rig.seedIssue({ title: 'x', labels: ['needs review/ui', 'bug'] });
      expect(
        await rig.issueTracker.removeLabels({
          repo: rig.repo,
          number,
          labels: ['needs review/ui', 'absent'],
        }),
      ).toEqual(['bug']);
      const deletes = (await apiCalls(rig)).filter((args) => args.includes('DELETE'));
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain(
        `repos/{owner}/{repo}/issues/${String(number)}/labels/needs%20review%2Fui`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'commentOnIssue on a pull request posts nothing',
    async () => {
      rig = await makeGithubRig();
      const pull = await rig.seedPullRequest();
      await expect(
        rig.issueTracker.commentOnIssue({ repo: rig.repo, number: pull, body: 'x' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await apiCalls(rig)).some((args) => args.includes('POST'))).toBe(false);
      const comments = await readFile(join(rig.root, 'gh', 'comments.json'), 'utf8').catch(
        () => '[]',
      );
      expect(JSON.parse(comments)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a failure of gh is classified: credentials are PermissionDenied',
    async () => {
      rig = await makeGithubRig({ config: { env: { FAKE_GH_FAIL: 'auth' } } });
      await expect(rig.issueTracker.listIssues({ repo: rig.repo })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    },
    TEST_TIMEOUT_MS,
  );
});
