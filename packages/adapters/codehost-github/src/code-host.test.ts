// SPDX-License-Identifier: MPL-2.0
import { isOTheaterError } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  classifyPushFailure,
  classifyToolFailure,
  GITHUB_CODE_HOST_ADAPTER,
  GithubCodeHost,
  GithubCodeHostConfigSchema,
  parseLsRemote,
  parsePullRequests,
  ToolRunner,
} from './index.js';
import { makeGithubRig, type GithubRig } from './rig.fixture.js';
import { SpawnLauncher } from './spawn-launcher.fixture.js';

afterAll(disposeTestGitIsolation);

const TEST_TIMEOUT_MS = 60_000;

function codeOf(error: unknown): string | undefined {
  return isOTheaterError(error) ? error.code : undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

const result = (stderr: string, stdout = '', code = 1) => ({ stdout, stderr, code });

describe('GithubCodeHostConfigSchema', () => {
  it('has a default for every key', () => {
    const config = GithubCodeHostConfigSchema.parse({});
    expect(config.ghBinary).toBe('gh');
    expect(config.gitBinary).toBe('git');
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.inheritEnv).toEqual([]);
    expect(config.env).toEqual({});
  });

  it('rejects an unknown key and a bad timeout', () => {
    expect(() => GithubCodeHostConfigSchema.parse({ token: 'x' })).toThrow();
    expect(() => GithubCodeHostConfigSchema.parse({ timeoutMs: 0 })).toThrow();
    expect(() => GithubCodeHostConfigSchema.parse({ ghBinary: '' })).toThrow();
  });

  it('identifies itself as an implementation of the CodeHost port', () => {
    expect(GITHUB_CODE_HOST_ADAPTER.id).toBe('github');
    expect(GITHUB_CODE_HOST_ADAPTER.implements.port).toBe('CodeHost');
  });
});

describe('failure classification', () => {
  it('maps a rejected push to Conflict', () => {
    const error = classifyPushFailure(
      'feature',
      result('! [rejected] feature -> feature (non-fast-forward)'),
    );
    expect(codeOf(error)).toBe('CONFLICT');
  });

  it('maps authentication and permission failures to PermissionDenied', () => {
    expect(codeOf(classifyToolFailure('gh pr list', result('gh auth login')))).toBe(
      'PERMISSION_DENIED',
    );
    expect(codeOf(classifyToolFailure('gh api', result('gh: Forbidden (HTTP 403)')))).toBe(
      'PERMISSION_DENIED',
    );
    expect(codeOf(classifyPushFailure('b', result('fatal: Authentication failed')))).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('maps server and network failures to Transient', () => {
    expect(codeOf(classifyToolFailure('gh api', result('gh: Server Error (HTTP 502)')))).toBe(
      'TRANSIENT',
    );
    expect(
      codeOf(classifyPushFailure('b', result('fatal: Could not resolve host: github.com'))),
    ).toBe('TRANSIENT');
  });

  it('maps already-exists and merge-conflict answers to Conflict, missing refs to NotFound', () => {
    expect(
      codeOf(classifyToolFailure('gh pr create', result('a pull request already exists'))),
    ).toBe('CONFLICT');
    expect(codeOf(classifyToolFailure('gh api', result('gh: Merge conflict (HTTP 409)')))).toBe(
      'CONFLICT',
    );
    expect(codeOf(classifyToolFailure('gh api', result('gh: Not Found (HTTP 404)')))).toBe(
      'NOT_FOUND',
    );
    expect(
      codeOf(classifyToolFailure('gh pr create', result('No commits between main and feature'))),
    ).toBe('INVALID_INPUT');
  });

  it('maps what it does not recognise to AdapterUnavailable', () => {
    expect(codeOf(classifyToolFailure('gh', result('something odd')))).toBe('ADAPTER_UNAVAILABLE');
  });
});

describe('parsers', () => {
  const sha = 'a'.repeat(40);

  it('parseLsRemote reads the exact ref, not a tail match', () => {
    const out = `${'b'.repeat(40)}\trefs/heads/other/feature\n${sha}\trefs/heads/feature\n`;
    expect(parseLsRemote(result('', out, 0), 'feature')).toBe(sha);
    expect(parseLsRemote(result('', out, 0), 'missing')).toBeUndefined();
    expect(parseLsRemote(result('', '', 0), 'feature')).toBeUndefined();
  });

  it('parsePullRequests maps the JSON of gh and drops unknown states', () => {
    const json = JSON.stringify([
      {
        number: 3,
        url: 'https://host.invalid/o/r/pull/3',
        state: 'MERGED',
        headRefName: 'f',
        baseRefName: 'main',
        title: 't',
        isDraft: false,
        createdAt: '2026-11-17T10:00:00Z',
      },
      {
        number: 4,
        url: 'u',
        state: 'SOMETHING_NEW',
        headRefName: 'f',
        baseRefName: 'main',
        title: 't',
        isDraft: false,
        createdAt: '2026-11-17T10:00:00Z',
      },
    ]);
    const pulls = parsePullRequests(json);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      number: 3,
      state: 'merged',
      headBranch: 'f',
      baseBranch: 'main',
      draft: false,
      createdAt: Date.parse('2026-11-17T10:00:00Z'),
    });
  });

  it('parsePullRequests treats empty output as no pull requests and bad output as unavailable', () => {
    expect(parsePullRequests('')).toEqual([]);
    expect(codeOf(catching(() => parsePullRequests('not json')))).toBe('ADAPTER_UNAVAILABLE');
    expect(codeOf(catching(() => parsePullRequests('[{"number":1}]')))).toBe('ADAPTER_UNAVAILABLE');
  });
});

function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('GithubCodeHost against a fake gh', () => {
  let rig: GithubRig | undefined;
  afterEach(async () => {
    await rig?.dispose();
    rig = undefined;
  });

  it(
    'runs the tools with a short, complete environment and never prompts',
    async () => {
      rig = await makeGithubRig({
        parentEnv: { GH_TOKEN: 'test-token', ANTHROPIC_API_KEY: 'must-not-pass' },
      });
      await rig.commit('feature');
      await rig.codeHost.pushRef({ repo: rig.repo, branch: 'feature' });
      await rig.codeHost.openPullRequest({
        repo: rig.repo,
        head: 'feature',
        base: 'main',
        title: 't',
        body: 'b',
      });
      const calls = await rig.ghCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.env).toContain('GH_TOKEN');
        expect(call.env).toContain('GH_PROMPT_DISABLED');
        expect(call.env).not.toContain('ANTHROPIC_API_KEY');
      }
      for (const launch of rig.launcher.launched) {
        expect(launch.env.GIT_TERMINAL_PROMPT).toBe('0');
        expect(launch.env.LC_ALL).toBe('C');
        expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pushes a full refspec without force',
    async () => {
      rig = await makeGithubRig();
      await rig.commit('feature');
      await rig.codeHost.pushRef({ repo: rig.repo, branch: 'feature' });
      const push = rig.launcher.launched.find((launch) => launch.args[0] === 'push');
      expect(push?.args).toContain('refs/heads/feature:refs/heads/feature');
      expect(push?.args.some((arg) => /^--force|^\+|-f$/.test(arg))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'opens the pull request through gh with head, base, title, body and draft',
    async () => {
      rig = await makeGithubRig();
      await rig.commit('feature');
      await rig.codeHost.pushRef({ repo: rig.repo, branch: 'feature' });
      await rig.codeHost.openPullRequest({
        repo: rig.repo,
        head: 'feature',
        base: 'main',
        title: 'Title',
        body: 'Body',
        draft: true,
      });
      const create = (await rig.ghCalls()).find(
        (call) => call.args[0] === 'pr' && call.args[1] === 'create',
      );
      expect(create?.args).toEqual(
        expect.arrayContaining([
          '--head',
          'feature',
          '--base',
          'main',
          '--title',
          'Title',
          '--body',
          'Body',
          '--draft',
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'findPullRequest sees closed and merged pull requests only when asked',
    async () => {
      rig = await makeGithubRig();
      await rig.commit('feature');
      await rig.codeHost.pushRef({ repo: rig.repo, branch: 'feature' });
      await rig.codeHost.openPullRequest({
        repo: rig.repo,
        head: 'feature',
        base: 'main',
        title: 't',
        body: '',
      });
      const { writeFile, readFile } = await import('node:fs/promises');
      const file = `${rig.root}/gh/prs.json`;
      const pulls = JSON.parse(await readFile(file, 'utf8')) as { state: string }[];
      for (const pull of pulls) pull.state = 'MERGED';
      await writeFile(file, JSON.stringify(pulls));
      expect(
        await rig.codeHost.findPullRequest({ repo: rig.repo, head: 'feature' }),
      ).toBeUndefined();
      const merged = await rig.codeHost.findPullRequest({
        repo: rig.repo,
        head: 'feature',
        states: ['merged'],
      });
      expect(merged?.state).toBe('merged');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'maps an authentication failure of gh to PermissionDenied',
    async () => {
      rig = await makeGithubRig({ config: { env: { FAKE_GH_FAIL: 'auth' } } });
      const error = await rejection(
        rig.codeHost.findPullRequest({ repo: rig.repo, head: 'feature' }),
      );
      expect(codeOf(error)).toBe('PERMISSION_DENIED');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'maps a server error of gh to Transient',
    async () => {
      rig = await makeGithubRig({ config: { env: { FAKE_GH_FAIL: 'http500' } } });
      const error = await rejection(
        rig.codeHost.findPullRequest({ repo: rig.repo, head: 'feature' }),
      );
      expect(codeOf(error)).toBe('TRANSIENT');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'kills a gh that does not finish within the timeout and fails Transient',
    async () => {
      rig = await makeGithubRig({ config: { timeoutMs: 500, env: { FAKE_GH_HANG: '1' } } });
      const error = await rejection(
        rig.codeHost.findPullRequest({ repo: rig.repo, head: 'feature' }),
      );
      expect(codeOf(error)).toBe('TRANSIENT');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a missing gh executable is AdapterUnavailable',
    async () => {
      rig = await makeGithubRig({ config: { ghBinary: '/nonexistent/gh' } });
      const error = await rejection(
        rig.codeHost.findPullRequest({ repo: rig.repo, head: 'feature' }),
      );
      expect(codeOf(error)).toBe('ADAPTER_UNAVAILABLE');
    },
    TEST_TIMEOUT_MS,
  );

  it('rejects a relative repo path and bad branch names as InvalidInput', async () => {
    const codeHost = new GithubCodeHost({ launcher: new SpawnLauncher() });
    expect(codeOf(await rejection(codeHost.remoteRef({ repo: 'relative', branch: 'b' })))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(await rejection(codeHost.remoteRef({ repo: '/tmp', branch: '-x' })))).toBe(
      'INVALID_INPUT',
    );
    expect(
      codeOf(
        await rejection(
          codeHost.openPullRequest({ repo: '/tmp', head: 'h', base: 'b', title: ' ', body: '' }),
        ),
      ),
    ).toBe('INVALID_INPUT');
  });
});

describe('ToolRunner', () => {
  it('rejects a timeout that is not a positive integer', () => {
    expect(() => new ToolRunner({ launcher: new SpawnLauncher(), timeoutMs: 0 })).toThrow();
  });

  it('returns the exit code instead of throwing for a failing command', async () => {
    const runner = new ToolRunner({
      launcher: new SpawnLauncher(),
      parentEnv: { PATH: process.env.PATH ?? '' },
    });
    const out = await runner.run('git', ['rev-parse', '--verify', '--quiet', 'nope'], '/tmp');
    expect(out.code).not.toBe(0);
  });
});
