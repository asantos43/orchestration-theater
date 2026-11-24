// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Conflict, NotFound, type Vcs } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  AutoCodeHost,
  isGithubUrl,
  LocalCodeHost,
  type CodeHostNotice,
  type GithubProbe,
} from './code-host.js';

const REPO = '/work/repo';
const HEAD = 'a'.repeat(40);

/** A `Vcs` that knows the heads it is told; only the history queries are used. */
function vcsWith(heads: Record<string, string>): Vcs {
  return {
    resolveRef: (_repo: string, ref: string) => {
      const sha = heads[ref.replace('refs/heads/', '')];
      return sha === undefined
        ? Promise.reject(new NotFound(`no ref ${ref}`))
        : Promise.resolve(sha);
    },
    findCommitByTrailer: () => Promise.resolve(undefined),
  } as unknown as Vcs;
}

function local(id: 'none' | 'fake', notices: CodeHostNotice[] = []): LocalCodeHost {
  return new LocalCodeHost({
    id,
    vcs: vcsWith({ 'play/p1/integration': HEAD, main: 'b'.repeat(40) }),
    now: () => 1_700_000_000_000,
    onNotice: (notice) => notices.push(notice),
  });
}

const PR = {
  repo: REPO,
  head: 'play/p1/integration',
  base: 'main',
  title: 'Deliver play p1',
  body: 'body',
};

describe('LocalCodeHost, none', () => {
  it('answers with the local heads and sends nothing anywhere', async () => {
    const host = local('none');
    expect(await host.pushRef({ repo: REPO, branch: 'play/p1/integration' })).toBe(HEAD);
    expect(await host.remoteRef({ repo: REPO, branch: 'play/p1/integration' })).toBe(HEAD);
    expect(await host.remoteRef({ repo: REPO, branch: 'missing' })).toBeUndefined();
  });

  it('records a pull request that was never opened and tells the situations', async () => {
    const notices: CodeHostNotice[] = [];
    const host = local('none', notices);
    const pull = await host.openPullRequest(PR);
    expect(pull).toMatchObject({
      number: 1,
      state: 'open',
      headBranch: PR.head,
      baseBranch: 'main',
    });
    expect(notices).toEqual([
      {
        kind: 'delivery_without_pr',
        subject: PR.head,
        detail: expect.stringContaining('no pull request was opened') as string,
      },
    ]);
    expect(await host.findPullRequest({ repo: REPO, head: PR.head })).toEqual(pull);
    await expect(host.openPullRequest(PR)).rejects.toBeInstanceOf(Conflict);
  });

  it('refuses a direct merge: it needs a host', async () => {
    await expect(
      local('none').mergeBranch({ repo: REPO, head: PR.head, base: 'main' }),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});

describe('LocalCodeHost, fake', () => {
  it('keeps a remote in memory and a journal, and tells nobody', async () => {
    const notices: CodeHostNotice[] = [];
    const host = local('fake', notices);
    expect(await host.remoteRef({ repo: REPO, branch: PR.head })).toBeUndefined();
    await host.pushRef({ repo: REPO, branch: PR.head });
    expect(await host.remoteRef({ repo: REPO, branch: PR.head })).toBe(HEAD);
    const pull = await host.openPullRequest(PR);
    expect(host.pullRequests()).toEqual([pull]);
    expect(host.calls.map((call) => call.method)).toEqual([
      'remoteRef',
      'pushRef',
      'remoteRef',
      'openPullRequest',
    ]);
    expect(notices).toEqual([]);
  });

  it('merges by marking the pull request, and says the branch is merged', async () => {
    const host = local('fake');
    await host.pushRef({ repo: REPO, branch: PR.head });
    await host.openPullRequest(PR);
    expect(await host.isBranchMerged({ repo: REPO, head: PR.head, base: 'main' })).toBe(false);
    expect(await host.mergeBranch({ repo: REPO, head: PR.head, base: 'main' })).toEqual({
      sha: HEAD,
    });
    expect(host.pullRequests()[0]?.state).toBe('merged');
    expect(await host.isBranchMerged({ repo: REPO, head: PR.head, base: 'main' })).toBe(true);
  });
});

describe('isGithubUrl', () => {
  it('knows the forms of a github.com remote', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
      'https://GitHub.com/owner/repo',
    ]) {
      expect(isGithubUrl(url)).toBe(true);
    }
  });

  it('refuses the others, a path that only mentions github.com included', () => {
    for (const url of [
      '/srv/git/repo.git',
      'https://gitlab.com/owner/repo.git',
      'git@ghe.example.com:owner/repo.git',
      'https://example.com/github.com/repo',
      'not a url',
    ]) {
      expect(isGithubUrl(url)).toBe(false);
    }
  });
});

describe('AutoCodeHost', () => {
  function build(probe: GithubProbe, withGithub = true) {
    const github = local('fake');
    const none = local('none');
    const reasons = new Map<string, string>();
    const auto = new AutoCodeHost({
      github: withGithub ? github : undefined,
      local: none,
      probe,
      reasons,
    });
    return { auto, github, none, reasons };
  }
  const probe = (url: string | undefined, credential: boolean): GithubProbe => ({
    remoteUrl: () => Promise.resolve(url),
    hasCredential: () => Promise.resolve(credential),
  });

  it('takes the GitHub adapter for a github.com remote with a credential', async () => {
    const { auto, github, none } = build(probe('git@github.com:o/r.git', true));
    await auto.pushRef({ repo: REPO, branch: PR.head });
    expect(github.calls).toHaveLength(1);
    expect(none.calls).toHaveLength(0);
  });

  it('takes the local host, with the reason, when the remote is not GitHub', async () => {
    const { auto, github, none, reasons } = build(probe('/srv/git/repo.git', true));
    await auto.pushRef({ repo: REPO, branch: PR.head });
    expect(github.calls).toHaveLength(0);
    expect(none.calls).toHaveLength(1);
    expect(reasons.get(REPO)).toMatch(/not on github\.com/);
  });

  it('takes the local host when there is no remote, no credential or no adapter', async () => {
    for (const [built, text] of [
      [build(probe(undefined, true)), /no remote "origin"/],
      [build(probe('https://github.com/o/r', false)), /no GitHub credential/],
      [build(probe('https://github.com/o/r', true), false), /not built/],
    ] as const) {
      await built.auto.pushRef({ repo: REPO, branch: PR.head });
      expect(built.none.calls).toHaveLength(1);
      expect(built.reasons.get(REPO)).toMatch(text);
    }
  });

  it('keeps its answer for the repository, so a delivery never changes host half way', async () => {
    let asked = 0;
    const { auto, github } = build({
      remoteUrl: () => {
        asked += 1;
        return Promise.resolve('https://github.com/o/r');
      },
      hasCredential: () => Promise.resolve(true),
    });
    await auto.pushRef({ repo: REPO, branch: PR.head });
    await auto.findPullRequest({ repo: REPO, head: PR.head });
    expect(asked).toBe(1);
    expect(github.calls).toHaveLength(2);
  });

  it('asks again after a probe that failed', async () => {
    let asked = 0;
    const { auto, github } = build({
      remoteUrl: () => {
        asked += 1;
        return asked === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve('https://github.com/o/r');
      },
      hasCredential: () => Promise.resolve(true),
    });
    await expect(auto.pushRef({ repo: REPO, branch: PR.head })).rejects.toThrow('boom');
    await auto.pushRef({ repo: REPO, branch: PR.head });
    expect(github.calls).toHaveLength(1);
  });
});
