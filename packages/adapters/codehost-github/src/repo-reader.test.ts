// SPDX-License-Identifier: MPL-2.0
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { makeGithubRig, type GithubRig } from './rig.fixture.js';

afterAll(disposeTestGitIsolation);

const TEST_TIMEOUT_MS = 60_000;

describe('GithubRepoReader against a fake gh', () => {
  let rig: GithubRig | undefined;
  afterEach(async () => {
    await rig?.dispose();
    rig = undefined;
  });

  const apiCalls = async (current: GithubRig): Promise<string[][]> =>
    (await current.ghCalls()).filter((call) => call.args[0] === 'api').map((call) => call.args);

  it(
    'listOpen reads the open pull requests, newest update first, and drops the ones before since',
    async () => {
      rig = await makeGithubRig();
      const first = await rig.seedPullRequest();
      const second = await rig.seedPullRequest();
      const third = await rig.seedPullRequest();
      await rig.touchPullRequest(first, {
        author: 'alice',
        labels: ['bug', 'ui'],
        updatedAt: '2026-11-25T10:00:00Z',
      });
      await rig.touchPullRequest(second, { updatedAt: '2026-11-25T12:00:00Z' });
      await rig.touchPullRequest(third, { updatedAt: '2026-11-24T09:00:00Z' });
      const since = Date.parse('2026-11-25T00:00:00Z');
      const list = await rig.reader.listOpen({ repo: rig.repo, since, limit: 10 });
      expect(list.map((pull) => pull.number)).toEqual([second, first]);
      expect(list[1]).toMatchObject({
        number: first,
        author: 'alice',
        labels: ['bug', 'ui'],
        updatedAt: Date.parse('2026-11-25T10:00:00Z'),
      });
      expect(list[1]?.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof list[1]?.createdAt).toBe('number');
      const calls = await apiCalls(rig);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(
        expect.arrayContaining([
          'repos/{owner}/{repo}/pulls',
          'state=open',
          'sort=updated',
          'direction=desc',
          'per_page=100',
          'page=1',
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'listOpen cuts the list at limit and refuses a limit that is not a positive integer',
    async () => {
      rig = await makeGithubRig();
      const first = await rig.seedPullRequest();
      const second = await rig.seedPullRequest();
      await rig.touchPullRequest(first, { updatedAt: '2026-11-25T10:00:00Z' });
      await rig.touchPullRequest(second, { updatedAt: '2026-11-25T11:00:00Z' });
      const list = await rig.reader.listOpen({ repo: rig.repo, since: 0, limit: 1 });
      expect(list.map((pull) => pull.number)).toEqual([second]);
      await expect(
        rig.reader.listOpen({ repo: rig.repo, since: 0, limit: 0 }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(
        rig.reader.listOpen({ repo: 'relative/path', since: 0, limit: 5 }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'isCollaborator is true for write and admin, false for read and for who is not a user',
    async () => {
      const current = await makeGithubRig();
      rig = current;
      await current.seedCollaborator('owner-1', 'admin');
      await current.seedCollaborator('dev-2', 'write');
      await current.seedCollaborator('reader-3', 'read');
      const check = (login: string): Promise<boolean> =>
        current.reader.isCollaborator({ repo: current.repo, login });
      expect(await check('owner-1')).toBe(true);
      expect(await check('dev-2')).toBe(true);
      expect(await check('reader-3')).toBe(false);
      // 404 of the API: not a user.
      expect(await check('nobody')).toBe(false);
      const before = (await apiCalls(rig)).length;
      // A login GitHub cannot have never reaches the API (nor the path of the endpoint).
      expect(await check('app[bot]')).toBe(false);
      expect(await check('../../admin')).toBe(false);
      expect((await apiCalls(rig)).length).toBe(before);
      expect((await apiCalls(rig))[0]).toContain(
        'repos/{owner}/{repo}/collaborators/owner-1/permission',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a failure of the API is thrown, never read as "not a collaborator"',
    async () => {
      rig = await makeGithubRig({ config: { env: { FAKE_GH_FAIL: 'http500' } } });
      await expect(
        rig.reader.isCollaborator({ repo: rig.repo, login: 'someone' }),
      ).rejects.toMatchObject({ code: 'TRANSIENT' });
      await expect(
        rig.reader.listOpen({ repo: rig.repo, since: 0, limit: 5 }),
      ).rejects.toMatchObject({ code: 'TRANSIENT' });
    },
    TEST_TIMEOUT_MS,
  );
});
