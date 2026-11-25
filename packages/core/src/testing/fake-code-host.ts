// SPDX-License-Identifier: MPL-2.0
import { Conflict, NotFound } from '../errors.js';
import type { AdapterImplements } from '../ports/adapter.js';
import {
  assertBranchName,
  assertNonEmptyText,
  ciLogMaxChars,
  CODE_HOST_PORT_VERSION,
  DEFAULT_REMOTE,
  isFailedCiRun,
  joinCiLogs,
  type BranchTarget,
  type CiLog,
  type CiRun,
  type CodeHost,
  type FetchCiLogOptions,
  type FetchPullRequestOptions,
  type FindPullRequestOptions,
  type MergeBranchOptions,
  type MergeBranchResult,
  type OpenPullRequestOptions,
  type PullRequest,
  type PullRequestDetails,
  type PullRequestState,
} from '../ports/code-host.js';
import { assertItemNumber } from '../ports/issue-tracker.js';

/** Methods of the port a test can make fail with {@link FakeCodeHost.failNext}. */
export type CodeHostMethod =
  | 'pushRef'
  | 'remoteRef'
  | 'openPullRequest'
  | 'findPullRequest'
  | 'mergeBranch'
  | 'isBranchMerged'
  | 'fetchPullRequest'
  | 'fetchCiLog';

/** A CI run a test puts on a commit ({@link FakeCodeHost.seedCiRun}). */
export interface FakeCiRunInput {
  readonly name: string;
  /** Default `completed`. */
  readonly status?: CiRun['status'];
  /** Default `success`; `null` for a run that has not ended. */
  readonly conclusion?: string | null;
  /** The log of its failed steps (read only when it failed). Default `''`. */
  readonly log?: string;
}

/** Login of who opens the pull requests of the fake. */
export const FAKE_CODE_HOST_AUTHOR = 'fake-user';

/** One call the fake received, for the assertions of a test. */
export interface CodeHostCall {
  readonly method: CodeHostMethod;
  readonly args: unknown;
}

export interface FakeCodeHostOptions {
  /** Source of `PullRequest.createdAt`. Default: the system time. */
  readonly clock?: { now(): number };
}

/**
 * A code host in memory: no git, no network. Commits are made up (`commitLocal`), the "remote" is
 * a map of branch to sha, and the ancestry of the shas is kept, so `pushRef` can tell a
 * fast-forward from a divergence and `isBranchMerged` can answer. Meant for the tests of the
 * Workspace and of the delivery, and for the conformance suite (`describeCodeHostConformance`).
 *
 * Every call is recorded in {@link calls}; `failNext` makes the next call of a method reject.
 */
export class FakeCodeHost implements CodeHost {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'CodeHost',
    range: `^${CODE_HOST_PORT_VERSION}`,
  };

  /** Every call received, in order. */
  readonly calls: CodeHostCall[] = [];

  readonly #now: () => number;
  readonly #parents = new Map<string, readonly string[]>();
  readonly #local = new Map<string, string>();
  readonly #remote = new Map<string, string>();
  readonly #pulls: PullRequest[] = [];
  readonly #conflicts = new Set<string>();
  readonly #failures = new Map<CodeHostMethod, Error[]>();
  readonly #bodies = new Map<number, string>();
  readonly #labels = new Map<number, readonly string[]>();
  readonly #runs = new Map<string, { readonly run: CiRun; readonly log: string }[]>();
  #shaCounter = 0;
  #runCounter = 0;

  constructor(options: FakeCodeHostOptions = {}) {
    const clock = options.clock;
    this.#now = clock === undefined ? () => Date.now() : () => clock.now();
  }

  // -- Test setup ---------------------------------------------------------------------------

  /**
   * Makes a new commit on a local branch (creating the branch when it does not exist) and returns
   * its sha. `parent` forces another parent than the branch's own tip: a way to make a
   * divergence.
   */
  commitLocal(repo: string, branch: string, parent?: string): string {
    const key = localKey(repo, branch);
    const parents = parent !== undefined ? [parent] : this.#tipOf(this.#local.get(key));
    const sha = this.#newCommit(parents);
    this.#local.set(key, sha);
    return sha;
  }

  /**
   * Points the local `branch` at a new root commit (history that shares nothing with the remote's):
   * the next push of it is not a fast-forward. Returns its sha.
   */
  seedLocalRoot(repo: string, branch: string): string {
    const sha = this.#newCommit([]);
    this.#local.set(localKey(repo, branch), sha);
    return sha;
  }

  /**
   * Points the local `branch` at `sha`, a commit that exists somewhere else (a real repository the
   * test also drives). The fake knows nothing of its history: for it, `sha` is a root commit.
   */
  adoptLocal(repo: string, branch: string, sha: string): void {
    this.#parents.set(sha, this.#parents.get(sha) ?? []);
    this.#local.set(localKey(repo, branch), sha);
  }

  /** Puts `branch` on the remote as a new root commit, local copy included. Returns its sha. */
  seedRemote(repo: string, branch: string, remote: string = DEFAULT_REMOTE): string {
    const sha = this.#newCommit([]);
    this.#local.set(localKey(repo, branch), sha);
    this.#remote.set(remoteKey(repo, remote, branch), sha);
    return sha;
  }

  /** Makes the merge of `head` into `base` on the remote conflict (as two edits to a line would). */
  conflictBetween(repo: string, head: string, base: string): void {
    this.#conflicts.add(`${repo}\0${head}\0${base}`);
  }

  /** The next call of `method` rejects with `error` (queued: one error per call). */
  failNext(method: CodeHostMethod, error: Error): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  /** Sets the state of a pull request, as someone on the host would (close, merge). */
  setPullRequestState(number: number, state: PullRequestState): void {
    const index = this.#pulls.findIndex((pull) => pull.number === number);
    const found = this.#pulls[index];
    if (found === undefined) throw new NotFound(`No pull request #${String(number)}`);
    this.#pulls[index] = { ...found, state };
  }

  /** Puts a CI run on the commit `sha` (the head of a pull request). Returns the run. */
  seedCiRun(sha: string, input: FakeCiRunInput): CiRun {
    this.#runCounter += 1;
    const id = String(this.#runCounter);
    const status = input.status ?? 'completed';
    const run: CiRun = {
      id,
      name: input.name,
      status,
      conclusion:
        input.conclusion === undefined
          ? status === 'completed'
            ? 'success'
            : null
          : input.conclusion,
      url: `https://code-host.invalid/runs/${id}`,
    };
    const list = this.#runs.get(sha) ?? [];
    list.push({ run, log: input.log ?? '' });
    this.#runs.set(sha, list);
    return run;
  }

  /** Sets the labels of a pull request, as someone on the host would. */
  setPullRequestLabels(number: number, labels: readonly string[]): void {
    if (!this.#pulls.some((pull) => pull.number === number)) {
      throw new NotFound(`No pull request #${String(number)}`);
    }
    this.#labels.set(number, [...new Set(labels)].sort());
  }

  // -- Inspection ---------------------------------------------------------------------------

  /** Every pull request, in creation order. */
  pullRequests(): readonly PullRequest[] {
    return [...this.#pulls];
  }

  /** How many times `method` was called. */
  callCount(method: CodeHostMethod): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** Local sha of a branch, or `undefined`. */
  localSha(repo: string, branch: string): string | undefined {
    return this.#local.get(localKey(repo, branch));
  }

  // -- The port -----------------------------------------------------------------------------

  pushRef(target: BranchTarget): Promise<string> {
    return this.#run('pushRef', target, () => {
      assertBranchName('branch', target.branch);
      const local = this.#local.get(localKey(target.repo, target.branch));
      if (local === undefined) throw new NotFound(`Branch not found: ${target.branch}`);
      const key = remoteKey(target.repo, target.remote ?? DEFAULT_REMOTE, target.branch);
      const remote = this.#remote.get(key);
      if (remote === local) return local;
      if (remote !== undefined && !this.#isAncestor(remote, local)) {
        throw new Conflict(`Not a fast-forward: ${target.branch}`);
      }
      this.#remote.set(key, local);
      return local;
    });
  }

  remoteRef(target: BranchTarget): Promise<string | undefined> {
    return this.#run('remoteRef', target, () => {
      assertBranchName('branch', target.branch);
      return this.#remote.get(
        remoteKey(target.repo, target.remote ?? DEFAULT_REMOTE, target.branch),
      );
    });
  }

  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    return this.#run('openPullRequest', opts, () => {
      assertBranchName('head', opts.head);
      assertBranchName('base', opts.base);
      assertNonEmptyText('title', opts.title);
      const remote = opts.remote ?? DEFAULT_REMOTE;
      if (!this.#remote.has(remoteKey(opts.repo, remote, opts.head))) {
        throw new NotFound(`Branch not on the remote: ${opts.head}`);
      }
      if (!this.#remote.has(remoteKey(opts.repo, remote, opts.base))) {
        throw new NotFound(`Branch not on the remote: ${opts.base}`);
      }
      const open = this.#pulls.find(
        (pull) =>
          pull.state === 'open' && pull.headBranch === opts.head && pull.baseBranch === opts.base,
      );
      if (open !== undefined) {
        throw new Conflict(
          `A pull request is already open for ${opts.head}: #${String(open.number)}`,
        );
      }
      const number = this.#pulls.length + 1;
      const pull: PullRequest = {
        number,
        url: `https://code-host.invalid/pull/${String(number)}`,
        state: 'open',
        headBranch: opts.head,
        baseBranch: opts.base,
        title: opts.title,
        draft: opts.draft === true,
        createdAt: this.#now(),
      };
      this.#pulls.push(pull);
      this.#bodies.set(number, opts.body);
      return pull;
    });
  }

  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    return this.#run('findPullRequest', opts, () => {
      assertBranchName('head', opts.head);
      const states = opts.states ?? ['open'];
      const matches = this.#pulls.filter(
        (pull) =>
          pull.headBranch === opts.head &&
          (opts.base === undefined || pull.baseBranch === opts.base) &&
          states.includes(pull.state),
      );
      return matches.at(-1);
    });
  }

  mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    return this.#run('mergeBranch', opts, () => {
      assertBranchName('head', opts.head);
      assertBranchName('base', opts.base);
      const remote = opts.remote ?? DEFAULT_REMOTE;
      const head = this.#remote.get(remoteKey(opts.repo, remote, opts.head));
      const baseKey = remoteKey(opts.repo, remote, opts.base);
      const base = this.#remote.get(baseKey);
      if (head === undefined) throw new NotFound(`Branch not on the remote: ${opts.head}`);
      if (base === undefined) throw new NotFound(`Branch not on the remote: ${opts.base}`);
      if (this.#isAncestor(head, base)) return { sha: base };
      if (this.#conflicts.has(`${opts.repo}\0${opts.head}\0${opts.base}`)) {
        throw new Conflict(`Merge conflict: ${opts.head} into ${opts.base}`);
      }
      const sha = this.#newCommit([base, head]);
      this.#remote.set(baseKey, sha);
      this.#pulls.forEach((pull, index) => {
        if (
          pull.state === 'open' &&
          pull.headBranch === opts.head &&
          pull.baseBranch === opts.base
        ) {
          this.#pulls[index] = { ...pull, state: 'merged' };
        }
      });
      return { sha };
    });
  }

  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    return this.#run('isBranchMerged', opts, () => {
      assertBranchName('head', opts.head);
      assertBranchName('base', opts.base);
      const remote = opts.remote ?? DEFAULT_REMOTE;
      const head = this.#remote.get(remoteKey(opts.repo, remote, opts.head));
      const base = this.#remote.get(remoteKey(opts.repo, remote, opts.base));
      if (head === undefined) throw new NotFound(`Branch not on the remote: ${opts.head}`);
      if (base === undefined) throw new NotFound(`Branch not on the remote: ${opts.base}`);
      return this.#isAncestor(head, base);
    });
  }

  fetchPullRequest(opts: FetchPullRequestOptions): Promise<PullRequestDetails> {
    return this.#run('fetchPullRequest', opts, () =>
      this.#details(opts.repo, opts.number, opts.remote),
    );
  }

  fetchCiLog(opts: FetchCiLogOptions): Promise<CiLog> {
    return this.#run('fetchCiLog', opts, () => {
      const maxChars = ciLogMaxChars(opts.maxChars);
      const { headSha } = this.#details(opts.repo, opts.number, opts.remote);
      const seeded = this.#runs.get(headSha) ?? [];
      const failed = seeded.filter((entry) => isFailedCiRun(entry.run));
      const { log, truncated } = joinCiLogs(
        failed.map((entry) => ({ run: entry.run, text: entry.log })),
        maxChars,
      );
      return { headSha, runs: seeded.map((entry) => entry.run), log, truncated };
    });
  }

  // -- Internals ----------------------------------------------------------------------------

  /**
   * Records the call, rejects with the error a test queued for it, and otherwise resolves with
   * what `fn` returns.
   */
  #run<T>(method: CodeHostMethod, args: unknown, fn: () => T): Promise<T> {
    try {
      this.calls.push({ method, args });
      const error = this.#failures.get(method)?.shift();
      if (error !== undefined) throw error;
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #details(repo: string, number: number, remote: string | undefined): PullRequestDetails {
    assertItemNumber('pull request number', number);
    const pull = this.#pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new NotFound(`No pull request #${String(number)}`);
    const headSha =
      this.#remote.get(remoteKey(repo, remote ?? DEFAULT_REMOTE, pull.headBranch)) ??
      this.#local.get(localKey(repo, pull.headBranch)) ??
      '';
    return {
      ...pull,
      body: this.#bodies.get(number) ?? '',
      author: FAKE_CODE_HOST_AUTHOR,
      headSha,
      labels: this.#labels.get(number) ?? [],
    };
  }

  #tipOf(sha: string | undefined): readonly string[] {
    return sha === undefined ? [] : [sha];
  }

  #newCommit(parents: readonly string[]): string {
    this.#shaCounter += 1;
    const sha = this.#shaCounter.toString(16).padStart(40, '0');
    this.#parents.set(sha, parents);
    return sha;
  }

  /** `ancestor` is `descendant` itself or reachable from it. */
  #isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const pending = [descendant];
    while (pending.length > 0) {
      const sha = pending.pop();
      if (sha === undefined || seen.has(sha)) continue;
      if (sha === ancestor) return true;
      seen.add(sha);
      pending.push(...(this.#parents.get(sha) ?? []));
    }
    return false;
  }
}

function localKey(repo: string, branch: string): string {
  return `${repo}\0${branch}`;
}

function remoteKey(repo: string, remote: string, branch: string): string {
  return `${repo}\0${remote}\0${branch}`;
}
