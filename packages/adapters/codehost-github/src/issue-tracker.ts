// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  assertItemNumber,
  assertLabels,
  assertNonEmptyText,
  InvalidInput,
  ISSUE_LIST_MAX,
  ISSUE_TRACKER_PORT_VERSION,
  issueListLimit,
  NotFound,
  type Adapter,
  type CommentOptions,
  type Issue,
  type IssueComment,
  type IssueRef,
  type IssueTracker,
  type LabelOptions,
  type ListIssuesOptions,
} from '@otheater/core';
import { z } from 'zod';
import type { GithubCodeHostOptions } from './code-host.js';
import { GithubCodeHostConfigSchema } from './config.js';
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
import { ToolRunner } from './runner.js';

/** Identity of this adapter for the composition point (architecture 5.18). */
export const GITHUB_ISSUE_TRACKER_ADAPTER: Adapter = {
  id: 'github',
  implements: { port: 'IssueTracker', range: `^${ISSUE_TRACKER_PORT_VERSION}` },
};

/** The same options as the `CodeHost` of GitHub: one `gh`, one configuration. [proposta] */
export type GithubIssueTrackerOptions = GithubCodeHostOptions;

/** What `GET repos/{owner}/{repo}/issues/N` returns, for the fields this adapter reads. */
const IssueJsonSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  labels: LabelsJsonSchema,
  user: UserJsonSchema,
  created_at: z.string(),
  updated_at: z.string(),
  /** Present when the "issue" is a pull request (the API numbers them together). */
  pull_request: z.unknown().optional(),
});

const CommentJsonSchema = z.object({
  id: z.number().int(),
  html_url: z.string().min(1),
  created_at: z.string(),
});

const PullNumberJsonSchema = z.object({ number: z.number().int().positive() });

/** Issues of one page of the API (its most). */
const PAGE_SIZE = ISSUE_LIST_MAX;

/**
 * Pages `listIssues` reads at most: the API mixes pull requests into the issues, so a page may
 * bring fewer than `limit` issues. [proposta]
 */
const MAX_LIST_PAGES = 5;

/**
 * The `IssueTracker` port over the GitHub CLI (N313, P7 of Phase 11b): every call is `gh api`
 * against the REST API, with the authentication of `gh` (no token of ours), started under the
 * `ProcessLauncher` in `repo`. `gh` finds the repository by the remotes of the checkout; the
 * `remote` of an option is not used. [proposta]
 */
export class GithubIssueTracker implements IssueTracker {
  readonly id = GITHUB_ISSUE_TRACKER_ADAPTER.id;
  readonly implements = GITHUB_ISSUE_TRACKER_ADAPTER.implements;

  readonly #api: GhApi;

  constructor(options: GithubIssueTrackerOptions) {
    const config = GithubCodeHostConfigSchema.parse(options.config ?? {});
    const runner = new ToolRunner({
      launcher: options.launcher,
      timeoutMs: config.timeoutMs,
      inheritEnv: config.inheritEnv,
      env: config.env,
      ...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
    });
    this.#api = new GhApi(runner, config.ghBinary);
  }

  async fetchIssue(ref: IssueRef): Promise<Issue> {
    checkedRef(ref, 'issue number');
    const raw = await this.#item(ref);
    if (raw.pull_request !== undefined) {
      throw new NotFound(`#${String(ref.number)} is a pull request, not an issue`);
    }
    return issueOf(raw);
  }

  async listIssues(opts: ListIssuesOptions): Promise<readonly Issue[]> {
    assertAbsolutePath(opts.repo);
    const limit = issueListLimit(opts.limit);
    const fields: [string, string][] = [
      ['state', opts.state ?? 'open'],
      ['sort', 'created'],
      ['direction', 'desc'],
      ['per_page', String(PAGE_SIZE)],
    ];
    if (opts.labels !== undefined && opts.labels.length > 0) {
      assertLabels(opts.labels);
      fields.push(['labels', opts.labels.join(',')]);
    }
    if (opts.author !== undefined) {
      assertNonEmptyText('author', opts.author);
      fields.push(['creator', opts.author]);
    }
    if (opts.since !== undefined) fields.push(['since', isoTime(opts.since)]);
    const issues: Issue[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES && issues.length < limit; page += 1) {
      const answer = await this.#api.json(
        opts.repo,
        'GET',
        'repos/{owner}/{repo}/issues',
        z.array(IssueJsonSchema),
        [...fields, ['page', String(page)]],
      );
      for (const raw of answer) {
        if (raw.pull_request === undefined) issues.push(issueOf(raw));
      }
      if (answer.length < PAGE_SIZE) break;
    }
    return issues.slice(0, limit);
  }

  async commentOnIssue(opts: CommentOptions): Promise<IssueComment> {
    checkedRef(opts, 'issue number');
    assertNonEmptyText('comment body', opts.body);
    // The endpoint of comments takes pull requests too: the kind is checked first.
    await this.fetchIssue(opts);
    return this.#comment(opts);
  }

  async commentOnPullRequest(opts: CommentOptions): Promise<IssueComment> {
    checkedRef(opts, 'pull request number');
    assertNonEmptyText('comment body', opts.body);
    try {
      await this.#api.json(
        opts.repo,
        'GET',
        `repos/{owner}/{repo}/pulls/${String(opts.number)}`,
        PullNumberJsonSchema,
      );
    } catch (error) {
      throw notFoundAs(`pull request #${String(opts.number)}`, error);
    }
    return this.#comment(opts);
  }

  async addLabels(opts: LabelOptions): Promise<readonly string[]> {
    checkedRef(opts, 'item number');
    assertLabels(opts.labels);
    try {
      const labels = await this.#api.json(
        opts.repo,
        'POST',
        `repos/{owner}/{repo}/issues/${String(opts.number)}/labels`,
        LabelsJsonSchema,
        opts.labels.map((label) => ['labels[]', label] as const),
      );
      return labelNames(labels);
    } catch (error) {
      throw notFoundAs(`issue or pull request #${String(opts.number)}`, error);
    }
  }

  /** Removes only the labels the item has (the API answers 404 for one it lacks). */
  async removeLabels(opts: LabelOptions): Promise<readonly string[]> {
    checkedRef(opts, 'item number');
    assertLabels(opts.labels);
    let labels = labelNames((await this.#item(opts)).labels);
    for (const label of new Set(opts.labels)) {
      if (!labels.includes(label)) continue;
      try {
        labels = labelNames(
          await this.#api.json(
            opts.repo,
            'DELETE',
            `repos/{owner}/{repo}/issues/${String(opts.number)}/labels/${encodeURIComponent(label)}`,
            LabelsJsonSchema,
          ),
        );
      } catch (error) {
        // Removed by someone else in between: the end state is the one asked for.
        if (!(error instanceof NotFound)) throw error;
        labels = labels.filter((name) => name !== label);
      }
    }
    return labels;
  }

  async #item(ref: IssueRef): Promise<z.output<typeof IssueJsonSchema>> {
    try {
      return await this.#api.json(
        ref.repo,
        'GET',
        `repos/{owner}/{repo}/issues/${String(ref.number)}`,
        IssueJsonSchema,
      );
    } catch (error) {
      throw notFoundAs(`issue #${String(ref.number)}`, error);
    }
  }

  async #comment(opts: CommentOptions): Promise<IssueComment> {
    const raw = await this.#api.json(
      opts.repo,
      'POST',
      `repos/{owner}/{repo}/issues/${String(opts.number)}/comments`,
      CommentJsonSchema,
      [['body', opts.body]],
    );
    return {
      id: String(raw.id),
      url: raw.html_url,
      createdAt: ghTime('gh api comments', raw.created_at),
    };
  }
}

function checkedRef(ref: IssueRef, what: string): void {
  assertAbsolutePath(ref.repo);
  assertItemNumber(what, ref.number);
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) {
    throw new InvalidInput(`since must be a time in ms since the epoch, got ${String(ms)}`);
  }
  return date.toISOString();
}

/** An issue of the API, in the terms of the port. */
export function issueOf(raw: z.output<typeof IssueJsonSchema>): Issue {
  const state = raw.state.toLowerCase();
  if (state !== 'open' && state !== 'closed') {
    throw new AdapterUnavailable(`gh api issues printed an unknown state: ${raw.state}`);
  }
  return {
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    body: raw.body ?? '',
    state,
    labels: labelNames(raw.labels),
    author: loginOf(raw.user),
    createdAt: ghTime('gh api issues', raw.created_at),
    updatedAt: ghTime('gh api issues', raw.updated_at),
  };
}
