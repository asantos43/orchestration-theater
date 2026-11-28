// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  assertBranchName,
  assertItemNumber,
  assertNonEmptyText,
  ciLogMaxChars,
  CODE_HOST_PORT_VERSION,
  Conflict,
  DEFAULT_REMOTE,
  NotFound,
  supportsHistory,
  type AdapterImplements,
  type BranchTarget,
  type CiLog,
  type CodeHost,
  type FetchCiLogOptions,
  type FetchPullRequestOptions,
  type FindPullRequestOptions,
  type MergeBranchOptions,
  type MergeBranchResult,
  type OpenPullRequestOptions,
  type PullRequest,
  type PullRequestDetails,
  type Vcs,
} from '@otheater/core';

/**
 * The code hosts of the daemon that are not an adapter (Phase 11, P13, N289). `compose.ts` is the
 * only file that imports adapters, so the host that needs none (`adapters.code_host: none | fake`)
 * and the one that picks between hosts (`auto`) live here, over the ports.
 */

/** What a code host tells the situations (`daemon.notice`). */
export interface CodeHostNotice {
  readonly kind: 'delivery_without_pr' | 'code_host_unavailable';
  readonly subject: string;
  readonly detail: string;
}

/** The call of a method of {@link LocalCodeHost}, in the order they happened. */
export interface LocalCodeHostCall {
  readonly method:
    | 'pushRef'
    | 'remoteRef'
    | 'openPullRequest'
    | 'findPullRequest'
    | 'mergeBranch'
    | 'isBranchMerged'
    | 'fetchPullRequest'
    | 'fetchCiLog';
  readonly args: unknown;
}

export interface LocalCodeHostOptions {
  /** `none`: no host (a delivery ends in a local record and a notice). `fake`: a host in memory, no notice. */
  readonly id: 'none' | 'fake';
  /** Where the heads of the branches are read (the repository itself). */
  readonly vcs: Vcs;
  readonly now: () => number;
  /** Why there is no host for `repo` (the `detail` of the notice). Used by `none` only. */
  readonly reason?: (repo: string) => string;
  readonly onNotice?: (notice: CodeHostNotice) => void;
}

const REMOTE_PREFIX = 'https://code-host.invalid';

/** Author of the pull requests a {@link LocalCodeHost} records. [proposta] */
export const LOCAL_AUTHOR = 'local';

/**
 * A code host that talks to nobody. [proposta]
 *
 * - `none` (no code host): `pushRef` and `remoteRef` answer with the local head of the branch (the
 *   branch is not sent anywhere), `openPullRequest` writes a record of the pull request that was
 *   never opened (number, local URL) and tells the situations (`delivery_without_pr`), so the
 *   play ends `DONE` with the work on the local branch, the event of the delivery has a number and
 *   the Producer is told that nothing was opened. A direct merge needs a host and is refused.
 * - Both read back the pull requests they recorded (`fetchPullRequest`, with the body given, the
 *   author `local`, no labels and the local head) and know no CI: `fetchCiLog` has no runs.
 * - `fake`: the same, but the remote is a map in memory (a push puts the head there, a
 *   `remoteRef` reads it) and nothing is told: it is the host of the tests that run the whole
 *   daemon (`adapters.code_host: fake`), whose `calls` and {@link pullRequests} are its journal.
 *
 * The records live in memory: a restart of the daemon starts them again.
 */
export class LocalCodeHost implements CodeHost {
  readonly id: 'none' | 'fake';
  readonly implements: AdapterImplements = {
    port: 'CodeHost',
    range: `^${CODE_HOST_PORT_VERSION}`,
  };
  readonly calls: LocalCodeHostCall[] = [];

  readonly #vcs: Vcs;
  readonly #now: () => number;
  readonly #reason: (repo: string) => string;
  readonly #onNotice: ((notice: CodeHostNotice) => void) | undefined;
  readonly #remote = new Map<string, string>();
  #pulls: PullRequest[] = [];
  readonly #bodies = new Map<number, string>();

  constructor(options: LocalCodeHostOptions) {
    this.id = options.id;
    this.#vcs = options.vcs;
    this.#now = options.now;
    this.#reason = options.reason ?? (() => 'adapters.code_host is none');
    this.#onNotice = options.onNotice;
  }

  /** The pull requests recorded, oldest first. */
  pullRequests(): readonly PullRequest[] {
    return [...this.#pulls];
  }

  async pushRef(target: BranchTarget): Promise<string> {
    this.calls.push({ method: 'pushRef', args: target });
    assertBranchName('branch', target.branch);
    const sha = await this.#head(target.repo, target.branch);
    if (this.id === 'fake') {
      this.#remote.set(remoteKey(target.repo, target.remote, target.branch), sha);
    }
    return sha;
  }

  async remoteRef(target: BranchTarget): Promise<string | undefined> {
    this.calls.push({ method: 'remoteRef', args: target });
    assertBranchName('branch', target.branch);
    if (this.id === 'fake') {
      return this.#remote.get(remoteKey(target.repo, target.remote, target.branch));
    }
    try {
      return await this.#head(target.repo, target.branch);
    } catch (error) {
      if (error instanceof NotFound) return undefined;
      throw error;
    }
  }

  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    this.calls.push({ method: 'openPullRequest', args: opts });
    assertBranchName('head', opts.head);
    assertBranchName('base', opts.base);
    assertNonEmptyText('title', opts.title);
    const open = this.#pulls.find(
      (pull) =>
        pull.state === 'open' && pull.headBranch === opts.head && pull.baseBranch === opts.base,
    );
    if (open !== undefined) {
      return Promise.reject(
        new Conflict(`A pull request is already open for ${opts.head}: #${String(open.number)}`),
      );
    }
    const number = this.#pulls.length + 1;
    const pull: PullRequest = {
      number,
      url: `${REMOTE_PREFIX}/${this.id}/pull/${String(number)}`,
      state: 'open',
      headBranch: opts.head,
      baseBranch: opts.base,
      title: opts.title,
      draft: opts.draft === true,
      createdAt: this.#now(),
    };
    this.#pulls.push(pull);
    this.#bodies.set(number, opts.body);
    if (this.id === 'none') {
      this.#onNotice?.({
        kind: 'delivery_without_pr',
        subject: opts.head,
        detail: `${this.#reason(opts.repo)}: no pull request was opened; the work is on the local branch ${opts.head}`,
      });
    }
    return Promise.resolve(pull);
  }

  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    this.calls.push({ method: 'findPullRequest', args: opts });
    assertBranchName('head', opts.head);
    const states = opts.states ?? ['open'];
    return Promise.resolve(
      this.#pulls
        .filter(
          (pull) =>
            pull.headBranch === opts.head &&
            (opts.base === undefined || pull.baseBranch === opts.base) &&
            states.includes(pull.state),
        )
        .at(-1),
    );
  }

  async mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    this.calls.push({ method: 'mergeBranch', args: opts });
    if (this.id === 'none') {
      throw new AdapterUnavailable(
        'There is no code host (adapters.code_host: none): a direct merge needs one',
      );
    }
    assertBranchName('head', opts.head);
    assertBranchName('base', opts.base);
    const sha = await this.#head(opts.repo, opts.head);
    this.#pulls = this.#pulls.map((pull) =>
      pull.state === 'open' && pull.headBranch === opts.head && pull.baseBranch === opts.base
        ? { ...pull, state: 'merged' }
        : pull,
    );
    return { sha };
  }

  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    this.calls.push({ method: 'isBranchMerged', args: opts });
    return Promise.resolve(
      this.#pulls.some(
        (pull) =>
          pull.state === 'merged' && pull.headBranch === opts.head && pull.baseBranch === opts.base,
      ),
    );
  }

  async fetchPullRequest(opts: FetchPullRequestOptions): Promise<PullRequestDetails> {
    this.calls.push({ method: 'fetchPullRequest', args: opts });
    return this.#details(opts);
  }

  async fetchCiLog(opts: FetchCiLogOptions): Promise<CiLog> {
    this.calls.push({ method: 'fetchCiLog', args: opts });
    ciLogMaxChars(opts.maxChars);
    const { headSha } = await this.#details(opts);
    return { headSha, runs: [], log: '', truncated: false };
  }

  async #details(opts: FetchPullRequestOptions): Promise<PullRequestDetails> {
    assertItemNumber('pull request number', opts.number);
    const pull = this.#pulls.find((candidate) => candidate.number === opts.number);
    if (pull === undefined) throw new NotFound(`No pull request #${String(opts.number)}`);
    const headSha =
      this.id === 'fake'
        ? (this.#remote.get(remoteKey(opts.repo, opts.remote, pull.headBranch)) ??
          (await this.#head(opts.repo, pull.headBranch)))
        : await this.#head(opts.repo, pull.headBranch);
    return {
      ...pull,
      body: this.#bodies.get(pull.number) ?? '',
      author: LOCAL_AUTHOR,
      headSha,
      labels: [],
    };
  }

  async #head(repo: string, branch: string): Promise<string> {
    if (!supportsHistory(this.#vcs)) {
      throw new AdapterUnavailable('The Vcs adapter cannot read the heads of the branches');
    }
    return this.#vcs.resolveRef(repo, `refs/heads/${branch}`);
  }
}

function remoteKey(repo: string, remote: string | undefined, branch: string): string {
  return `${repo}\0${remote ?? DEFAULT_REMOTE}\0${branch}`;
}

/** The two questions `auto` asks about a repository (answered by the GitHub CLI and git). */
export interface GithubProbe {
  /** The URL of `remote` in `repo`; `undefined` when there is no such remote. */
  remoteUrl(repo: string, remote: string): Promise<string | undefined>;
  /** Whether `gh` is logged in (a token of the vault counts, and the probe knows it). */
  hasCredential(repo: string): Promise<boolean>;
}

/** The host names `auto` takes for GitHub. */
export function isGithubUrl(url: string): boolean {
  const text = url.trim();
  const scp = /^[\w.-]+@([^:/]+):/.exec(text);
  if (scp?.[1] !== undefined) return scp[1].toLowerCase() === 'github.com';
  try {
    return new URL(text).hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

export interface AutoCodeHostOptions {
  /** `undefined` when the adapter could not be built (no process launcher). */
  readonly github: CodeHost | undefined;
  readonly local: LocalCodeHost;
  readonly probe: GithubProbe;
  /** Why `github` is `undefined`. */
  readonly githubMissing?: string;
  /** Records why a repository has no host; the same text is the `detail` of the local notice. */
  readonly reasons: Map<string, string>;
}

/**
 * `adapters.code_host: auto`: GitHub when the remote of the repository is on github.com and `gh`
 * has a credential, no host (the local one) otherwise. The answer is kept per `(repo, remote)` for
 * the life of the daemon, so a delivery never changes host half way; logging in or changing the
 * remote takes effect on the next start, or with `adapters.code_host: github`. [proposta]
 */
export class AutoCodeHost implements CodeHost {
  readonly id = 'auto';
  readonly implements: AdapterImplements = {
    port: 'CodeHost',
    range: `^${CODE_HOST_PORT_VERSION}`,
  };

  readonly #options: AutoCodeHostOptions;
  readonly #chosen = new Map<string, Promise<CodeHost>>();

  constructor(options: AutoCodeHostOptions) {
    this.#options = options;
  }

  pushRef(target: BranchTarget): Promise<string> {
    return this.#pick(target.repo, target.remote).then((host) => host.pushRef(target));
  }

  remoteRef(target: BranchTarget): Promise<string | undefined> {
    return this.#pick(target.repo, target.remote).then((host) => host.remoteRef(target));
  }

  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.openPullRequest(opts));
  }

  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.findPullRequest(opts));
  }

  mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.mergeBranch(opts));
  }

  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.isBranchMerged(opts));
  }

  fetchPullRequest(opts: FetchPullRequestOptions): Promise<PullRequestDetails> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.fetchPullRequest(opts));
  }

  fetchCiLog(opts: FetchCiLogOptions): Promise<CiLog> {
    return this.#pick(opts.repo, opts.remote).then((host) => host.fetchCiLog(opts));
  }

  /**
   * The host chosen for `(repo, remote)`: the GitHub adapter or the local one. The issue tracker
   * of `adapters.issue_tracker: same_as_code_host` follows it.
   */
  hostFor(repo: string, remote?: string): Promise<CodeHost> {
    return this.#pick(repo, remote);
  }

  /** Why the repository got the local host (after `hostFor`); a default text when nothing was recorded. */
  reasonFor(repo: string): string {
    return this.#options.reasons.get(repo) ?? 'it is not on GitHub or has no credential';
  }

  #pick(repo: string, remote: string | undefined): Promise<CodeHost> {
    const name = remote ?? DEFAULT_REMOTE;
    const key = `${repo}\0${name}`;
    let found = this.#chosen.get(key);
    if (found === undefined) {
      found = this.#decide(repo, name);
      this.#chosen.set(key, found);
      // A probe that failed is asked again on the next call.
      found.catch(() => this.#chosen.delete(key));
    }
    return found;
  }

  async #decide(repo: string, remote: string): Promise<CodeHost> {
    const { github, local, probe, reasons } = this.#options;
    const why = (text: string): CodeHost => {
      reasons.set(repo, text);
      return local;
    };
    if (github === undefined) {
      return why(this.#options.githubMissing ?? 'the GitHub adapter was not built');
    }
    const url = await probe.remoteUrl(repo, remote);
    if (url === undefined) return why(`the repository has no remote "${remote}"`);
    if (!isGithubUrl(url)) {
      return why(`the remote "${remote}" is not on github.com (set adapters.code_host: github)`);
    }
    if (!(await probe.hasCredential(repo))) {
      return why('there is no GitHub credential (log in with `gh auth login` or store a token)');
    }
    return github;
  }
}
