// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, NotFound } from '@otheater/core';
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
  UserJsonSchema,
} from './gh-api.js';
import { ToolRunner } from './runner.js';

/**
 * What the triggers of the workflow bindings read of GitHub beyond the ports of the core (Phase
 * 11b, P10a): the open pull requests of a repository and who has a role in it. [proposta] They are
 * not in the `CodeHost` port (0.2.0), so they are a class of their own over the same `gh api`, with
 * the same options as `GithubCodeHost`; the daemon hands it to the triggers as their
 * `PullRequestLister` and `CollaboratorCheck` (the shapes below are the ones of those two ports).
 */

/** One open pull request, as much as the triggers read of it. */
export interface GithubPullSummary {
  readonly number: number;
  readonly author: string;
  readonly labels: readonly string[];
  readonly headSha: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  /** ms since the epoch. */
  readonly updatedAt: number;
}

/** What `GET repos/{owner}/{repo}/pulls` returns, for the fields this reader needs. */
const PullListJsonSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    user: UserJsonSchema,
    labels: LabelsJsonSchema,
    head: z.object({ sha: z.string().min(1) }),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

/** What `GET repos/{owner}/{repo}/collaborators/{login}/permission` returns. */
const PermissionJsonSchema = z.object({ permission: z.string() });

/** The page of the API (its most). */
const PAGE_SIZE = 100;

/** Pages `listOpen` reads at most (`limit` is at most 100 in the settings, so one page is usually enough). [proposta] */
const MAX_PAGES = 5;

/** The shape of a login of GitHub (1 to 39 letters, digits and single hyphens). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The permissions that make a login a collaborator for `workflows.triggers.authors: collaborators`.
 * [proposta] `write` and `admin` (the `permission` field of the API maps `maintain` to `write`);
 * `read` is left out because on a public repository everybody has it.
 */
const COLLABORATOR_PERMISSIONS: readonly string[] = ['admin', 'write'];

export class GithubRepoReader {
  readonly #api: GhApi;

  constructor(options: GithubCodeHostOptions) {
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

  /**
   * The open pull requests updated at or after `since`, most recently updated first, at most
   * `limit`. The API has no `since` for pull requests: it sorts by update, and the reader stops at
   * the first page that has an entry older than `since`.
   */
  async listOpen(opts: {
    readonly repo: string;
    readonly since: number;
    readonly limit: number;
  }): Promise<readonly GithubPullSummary[]> {
    assertAbsolutePath(opts.repo);
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) {
      throw new InvalidInput(`limit must be a positive integer, got ${String(opts.limit)}`);
    }
    const found: GithubPullSummary[] = [];
    for (let page = 1; page <= MAX_PAGES && found.length < opts.limit; page += 1) {
      const answer = await this.#api.json(
        opts.repo,
        'GET',
        'repos/{owner}/{repo}/pulls',
        PullListJsonSchema,
        [
          ['state', 'open'],
          ['sort', 'updated'],
          ['direction', 'desc'],
          ['per_page', String(PAGE_SIZE)],
          ['page', String(page)],
        ],
      );
      let reachedOld = false;
      for (const raw of answer) {
        const updatedAt = ghTime('gh api pulls', raw.updated_at);
        if (updatedAt < opts.since) {
          reachedOld = true;
          continue;
        }
        found.push({
          number: raw.number,
          author: loginOf(raw.user),
          labels: labelNames(raw.labels),
          headSha: raw.head.sha,
          createdAt: ghTime('gh api pulls', raw.created_at),
          updatedAt,
        });
      }
      if (reachedOld || answer.length < PAGE_SIZE) break;
    }
    return found
      .sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number)
      .slice(0, opts.limit);
  }

  /**
   * Whether `login` has `write` or `admin` on the repository. A login GitHub cannot have (a
   * `[bot]` account, a name with another character) and a 404 answer `false`; any other failure of
   * the API is thrown, so the caller does not read it as "not a collaborator".
   */
  async isCollaborator(opts: { readonly repo: string; readonly login: string }): Promise<boolean> {
    assertAbsolutePath(opts.repo);
    if (!LOGIN.test(opts.login)) return false;
    try {
      const answer = await this.#api.json(
        opts.repo,
        'GET',
        `repos/{owner}/{repo}/collaborators/${opts.login}/permission`,
        PermissionJsonSchema,
      );
      return COLLABORATOR_PERMISSIONS.includes(answer.permission);
    } catch (error) {
      if (error instanceof NotFound) return false;
      throw error;
    }
  }
}
