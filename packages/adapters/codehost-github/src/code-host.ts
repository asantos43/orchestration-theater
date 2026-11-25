// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  assertBranchName,
  assertItemNumber,
  assertNonEmptyText,
  ciLogMaxChars,
  CODE_HOST_PORT_VERSION,
  DEFAULT_REMOTE,
  isFailedCiRun,
  joinCiLogs,
  NotFound,
  PULL_REQUEST_STATES,
  type Adapter,
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
  type ProcessLauncher,
  type PullRequest,
  type PullRequestDetails,
} from '@otheater/core';
import { z } from 'zod';
import type { GithubCodeHostConfigInput } from './config.js';
import { GithubCodeHostConfigSchema } from './config.js';
import { classifyPushFailure, classifyToolFailure } from './failure.js';
import {
  assertAbsolutePath,
  GhApi,
  ghTime,
  labelNames,
  LabelsJsonSchema,
  loginOf,
  notFoundAs,
  UserJsonSchema,
} from './gh-api.js';
import { ToolRunner, type ToolResult } from './runner.js';

/** Identity of this adapter for the composition point (architecture 5.18). */
export const GITHUB_CODE_HOST_ADAPTER: Adapter = {
  id: 'github',
  implements: { port: 'CodeHost', range: `^${CODE_HOST_PORT_VERSION}` },
};

export interface GithubCodeHostOptions {
  /** Starts `gh` and `git`; the daemon passes its `ProcessLauncher`. */
  readonly launcher: ProcessLauncher;
  readonly config?: GithubCodeHostConfigInput;
  /** The environment the tools inherit from. Default: `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
}

/** What `gh pr list --json` returns, for the fields this adapter asks for. */
const PullRequestJsonSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  title: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
});

const PULL_REQUEST_FIELDS = 'number,url,state,headRefName,baseRefName,title,isDraft,createdAt';

/** Most pull requests of one branch `findPullRequest` reads (a branch has a handful). [proposta] */
const PULL_REQUEST_LIMIT = '100';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** What `GET repos/{owner}/{repo}/pulls/N` returns, for the fields this adapter reads. */
const PullJsonSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  title: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  user: UserJsonSchema,
  labels: LabelsJsonSchema,
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** What `GET repos/{owner}/{repo}/actions/runs` returns, for the fields this adapter reads. */
const RunsJsonSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string().nullable().optional(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
      created_at: z.string(),
    }),
  ),
});

/** Runs of one commit `fetchCiLog` reads (one page of the API). [proposta] */
const CI_RUNS_PAGE = '100';

/**
 * The `CodeHost` port over the GitHub CLI (architecture 5.5, 5.18). Pull requests and the direct
 * merge go through `gh` (its own authentication, no token of ours); the push and the question "is
 * the branch on the remote" go through `git`. Both start under the `ProcessLauncher`, in
 * `repo`, with an argument array and a short environment (see {@link ToolRunner}).
 *
 * `gh` finds the repository by the remotes of the checkout. [proposta] The `remote` of an option
 * is used by the git calls (push, ls-remote); `gh` resolves the repository on its own.
 */
export class GithubCodeHost implements CodeHost {
  readonly id = GITHUB_CODE_HOST_ADAPTER.id;
  readonly implements = GITHUB_CODE_HOST_ADAPTER.implements;

  readonly #runner: ToolRunner;
  readonly #gh: string;
  readonly #git: string;
  readonly #api: GhApi;

  constructor(options: GithubCodeHostOptions) {
    const config = GithubCodeHostConfigSchema.parse(options.config ?? {});
    this.#gh = config.ghBinary;
    this.#git = config.gitBinary;
    this.#runner = new ToolRunner({
      launcher: options.launcher,
      timeoutMs: config.timeoutMs,
      inheritEnv: config.inheritEnv,
      env: config.env,
      ...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
    });
    this.#api = new GhApi(this.#runner, this.#gh);
  }

  async pushRef(target: BranchTarget): Promise<string> {
    const { repo, branch, remote } = checkedTarget(target);
    const local = await this.#localSha(repo, branch);
    // The full refspec, no `+`: a push that is not a fast-forward is refused, never forced.
    const result = await this.#runner.run(
      this.#git,
      ['push', '--no-verify', '--quiet', remote, `refs/heads/${branch}:refs/heads/${branch}`],
      repo,
    );
    if (result.code !== 0) throw classifyPushFailure(branch, result);
    return local;
  }

  async remoteRef(target: BranchTarget): Promise<string | undefined> {
    const { repo, branch, remote } = checkedTarget(target);
    return this.#remoteSha(repo, branch, remote);
  }

  async openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest> {
    assertAbsolutePath(opts.repo);
    assertBranchName('head', opts.head);
    assertBranchName('base', opts.base);
    assertNonEmptyText('title', opts.title);
    const remote = opts.remote ?? DEFAULT_REMOTE;
    assertBranchName('remote', remote);
    // gh reports a missing head as a GraphQL error; asking git first gives a clean `NotFound`.
    if ((await this.#remoteSha(opts.repo, opts.head, remote)) === undefined) {
      throw new NotFound(`Branch not on the remote: ${opts.head}`);
    }
    const args = [
      'pr',
      'create',
      '--head',
      opts.head,
      '--base',
      opts.base,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ];
    if (opts.draft === true) args.push('--draft');
    const created = await this.#runner.run(this.#gh, args, opts.repo);
    if (created.code !== 0) throw classifyToolFailure('gh pr create', created);
    const found = await this.findPullRequest({
      repo: opts.repo,
      head: opts.head,
      base: opts.base,
      states: ['open'],
    });
    if (found === undefined) {
      throw new AdapterUnavailable(
        `gh pr create succeeded but the pull request of ${opts.head} was not found afterwards`,
      );
    }
    return found;
  }

  async findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined> {
    assertAbsolutePath(opts.repo);
    assertBranchName('head', opts.head);
    if (opts.base !== undefined) assertBranchName('base', opts.base);
    const states = opts.states ?? ['open'];
    const args = [
      'pr',
      'list',
      '--head',
      opts.head,
      '--state',
      'all',
      '--limit',
      PULL_REQUEST_LIMIT,
      '--json',
      PULL_REQUEST_FIELDS,
    ];
    if (opts.base !== undefined) args.push('--base', opts.base);
    const result = await this.#runner.run(this.#gh, args, opts.repo);
    if (result.code !== 0) throw classifyToolFailure('gh pr list', result);
    const pulls = parsePullRequests(result.stdout)
      // `--head` matches by name, also on forks of another owner: the exact name is checked.
      .filter(
        (pull) =>
          pull.headBranch === opts.head &&
          (opts.base === undefined || pull.baseBranch === opts.base) &&
          states.includes(pull.state),
      )
      .sort((a, b) => a.number - b.number);
    return pulls.at(-1);
  }

  async mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult> {
    assertAbsolutePath(opts.repo);
    assertBranchName('head', opts.head);
    assertBranchName('base', opts.base);
    const remote = opts.remote ?? DEFAULT_REMOTE;
    assertBranchName('remote', remote);
    if ((await this.#remoteSha(opts.repo, opts.head, remote)) === undefined) {
      throw new NotFound(`Branch not on the remote: ${opts.head}`);
    }
    if ((await this.#remoteSha(opts.repo, opts.base, remote)) === undefined) {
      throw new NotFound(`Branch not on the remote: ${opts.base}`);
    }
    // `{owner}` and `{repo}` are filled in by gh from the remote of the checkout.
    const args = [
      'api',
      '--method',
      'POST',
      'repos/{owner}/{repo}/merges',
      '-f',
      `base=${opts.base}`,
      '-f',
      `head=${opts.head}`,
      '--jq',
      '.sha',
    ];
    if (opts.message !== undefined) {
      assertNonEmptyText('merge message', opts.message);
      args.push('-f', `commit_message=${opts.message}`);
    }
    const result = await this.#runner.run(this.#gh, args, opts.repo);
    if (result.code !== 0) throw classifyToolFailure('gh api merges', result);
    const sha = result.stdout.trim();
    if (SHA.test(sha)) return { sha };
    // The host answers 204 with no body when there was nothing to merge: the base is as it was.
    const current = await this.#remoteSha(opts.repo, opts.base, remote);
    if (current === undefined) throw new NotFound(`Branch not on the remote: ${opts.base}`);
    return { sha: current };
  }

  async isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean> {
    assertAbsolutePath(opts.repo);
    assertBranchName('head', opts.head);
    assertBranchName('base', opts.base);
    const args = [
      'api',
      `repos/{owner}/{repo}/compare/${opts.base}...${opts.head}`,
      '--jq',
      '.status',
    ];
    const result = await this.#runner.run(this.#gh, args, opts.repo);
    if (result.code !== 0) throw classifyToolFailure('gh api compare', result);
    const status = result.stdout.trim();
    // `identical`/`behind`: the head has nothing the base lacks. `ahead`/`diverged`: it has.
    if (status === 'identical' || status === 'behind') return true;
    if (status === 'ahead' || status === 'diverged') return false;
    throw new AdapterUnavailable(`gh api compare answered an unknown status: ${status}`);
  }

  async fetchPullRequest(opts: FetchPullRequestOptions): Promise<PullRequestDetails> {
    assertAbsolutePath(opts.repo);
    assertItemNumber('pull request number', opts.number);
    let raw: z.output<typeof PullJsonSchema>;
    try {
      raw = await this.#api.json(
        opts.repo,
        'GET',
        `repos/{owner}/{repo}/pulls/${String(opts.number)}`,
        PullJsonSchema,
      );
    } catch (error) {
      throw notFoundAs(`pull request #${String(opts.number)}`, error);
    }
    return pullDetails(raw);
  }

  /**
   * The runs of the head of the pull request (one page of the API, oldest first) and, for each
   * failed one, `gh run view <id> --log-failed`, joined and cut by `joinCiLogs`. [proposta]
   */
  async fetchCiLog(opts: FetchCiLogOptions): Promise<CiLog> {
    const maxChars = ciLogMaxChars(opts.maxChars);
    const pull = await this.fetchPullRequest(opts);
    const answer = await this.#api.json(
      opts.repo,
      'GET',
      'repos/{owner}/{repo}/actions/runs',
      RunsJsonSchema,
      [
        ['head_sha', pull.headSha],
        ['per_page', CI_RUNS_PAGE],
      ],
    );
    const runs = parseRuns(answer);
    const parts: { run: CiRun; text: string }[] = [];
    for (const run of runs.filter(isFailedCiRun)) {
      const text = await this.#api.run(opts.repo, 'gh run view', [
        'run',
        'view',
        run.id,
        '--log-failed',
      ]);
      parts.push({ run, text });
    }
    const { log, truncated } = joinCiLogs(parts, maxChars);
    return { headSha: pull.headSha, runs, log, truncated };
  }

  async #localSha(repo: string, branch: string): Promise<string> {
    const result = await this.#runner.run(
      this.#git,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
      repo,
    );
    const sha = result.stdout.trim();
    if (result.code === 0 && SHA.test(sha)) return sha;
    if (result.code === 1) throw new NotFound(`Branch not found: ${branch}`);
    throw classifyToolFailure('git rev-parse', result);
  }

  async #remoteSha(repo: string, branch: string, remote: string): Promise<string | undefined> {
    const result = await this.#runner.run(
      this.#git,
      ['ls-remote', '--heads', remote, `refs/heads/${branch}`],
      repo,
    );
    if (result.code !== 0) throw classifyToolFailure('git ls-remote', result);
    return parseLsRemote(result, branch);
  }
}

function checkedTarget(target: BranchTarget): { repo: string; branch: string; remote: string } {
  assertAbsolutePath(target.repo);
  assertBranchName('branch', target.branch);
  const remote = target.remote ?? DEFAULT_REMOTE;
  assertBranchName('remote', remote);
  return { repo: target.repo, branch: target.branch, remote };
}

/** The pull request of `GET pulls/N`, in the terms of the port. */
export function pullDetails(raw: z.output<typeof PullJsonSchema>): PullRequestDetails {
  const state = raw.merged_at != null ? 'merged' : raw.state.toLowerCase();
  if (!isPullRequestState(state)) {
    throw new AdapterUnavailable(`gh api pulls printed an unknown state: ${raw.state}`);
  }
  return {
    number: raw.number,
    url: raw.html_url,
    state,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    title: raw.title,
    draft: raw.draft ?? false,
    createdAt: ghTime('gh api pulls', raw.created_at),
    body: raw.body ?? '',
    author: loginOf(raw.user),
    headSha: raw.head.sha,
    labels: labelNames(raw.labels),
  };
}

/**
 * The runs of `GET actions/runs`, oldest first. A status other than `in_progress` or `completed`
 * (`queued`, `waiting`, `requested`, `pending`) is `queued`. [proposta]
 */
export function parseRuns(answer: z.output<typeof RunsJsonSchema>): CiRun[] {
  return answer.workflow_runs
    .map((run) => ({ run, at: ghTime('gh api actions/runs', run.created_at) }))
    .sort((a, b) => a.at - b.at || a.run.id - b.run.id)
    .map(({ run }) => {
      const status =
        run.status === 'completed' || run.status === 'in_progress' ? run.status : 'queued';
      return {
        id: String(run.id),
        name: run.name ?? `run ${String(run.id)}`,
        status,
        conclusion: status === 'completed' ? run.conclusion : null,
        url: run.html_url,
      };
    });
}

/** The sha of exactly `refs/heads/<branch>` in `git ls-remote` output (a tail match is not it). */
export function parseLsRemote(result: ToolResult, branch: string): string | undefined {
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (ref === `refs/heads/${branch}` && sha !== undefined && SHA.test(sha)) return sha;
  }
  return undefined;
}

/** Reads the JSON of `gh pr list`. Anything but a well-formed list is `AdapterUnavailable`. */
export function parsePullRequests(stdout: string): PullRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  } catch (error) {
    throw new AdapterUnavailable('gh pr list did not print JSON', { cause: error });
  }
  const parsed = z.array(PullRequestJsonSchema).safeParse(raw);
  if (!parsed.success) {
    throw new AdapterUnavailable('gh pr list printed an unexpected shape', { cause: parsed.error });
  }
  return parsed.data.flatMap((entry) => {
    const state = entry.state.toLowerCase();
    if (!isPullRequestState(state)) return [];
    const createdAt = Date.parse(entry.createdAt);
    if (Number.isNaN(createdAt)) {
      throw new AdapterUnavailable(`gh pr list printed a bad date: ${entry.createdAt}`);
    }
    return [
      {
        number: entry.number,
        url: entry.url,
        state,
        headBranch: entry.headRefName,
        baseBranch: entry.baseRefName,
        title: entry.title,
        draft: entry.isDraft,
        createdAt,
      },
    ];
  });
}

function isPullRequestState(value: string): value is PullRequest['state'] {
  return (PULL_REQUEST_STATES as readonly string[]).includes(value);
}
