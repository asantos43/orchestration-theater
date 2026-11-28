// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  isFailedCiRun,
  type IssueTracker,
  type WorkflowBindingRecord,
} from '@otheater/core';
import type { AuthorGate } from './authors.js';
import type { WorkflowTriggersSettings } from './config.js';
import type { TriggerFirer, TriggerItem } from './fire.js';
import type { PollSource } from './poll-loop.js';
import type { SeenLedger } from './seen.js';
import {
  type BindingTrigger,
  type CiReader,
  labelsFit,
  type ParsedTrigger,
  type PullRequestLister,
  type PullRequestSummary,
} from './types.js';

/**
 * The triggers of the code host, by polling (docs/24 section 8; plan of Phase 11b, P6): the
 * daemon listens on 127.0.0.1 only (Q16), so it asks the host. Each trigger of an active binding
 * is one {@link PollSource} of the loop; one look lists what changed since the binding was made
 * and hands each new item to the firer, after the filters:
 *
 * - the item is newer than the binding (an issue opened or a pull request created at or after
 *   `binding.createdAt`; for `issue_labeled` and `ci_failed`, updated since then), so a new binding
 *   never answers the history of the repository;
 * - the labels of the filter (`labels`, every one; `labels_any`, at least one);
 * - the author (`workflows.triggers.authors`): an author that is not allowed drops the item for
 *   good, with `workflow.trigger.skipped` (reason `author`);
 * - the ledger: an item the binding dealt with before is not looked at again.
 *
 * The keys: `issue_opened:<n>`, `issue_labeled:<n>:<label>`, `pr_opened:<n>`,
 * `ci_failed:<n>:<head sha>` (a new push that fails again is a new failure). [proposta] Items go
 * oldest first, so the runs start in the order the issues were opened.
 */

export interface CodeHostSourceDeps {
  readonly settings: () => Pick<WorkflowTriggersSettings, 'poll'>;
  readonly tracker?: Pick<IssueTracker, 'listIssues'> | undefined;
  readonly pullRequests?: PullRequestLister | undefined;
  readonly ci?: CiReader | undefined;
  /** The repository of the scenario (the `repo` of the calls of the ports). */
  readonly repoOf: (scenarioId: string) => string | Promise<string>;
  readonly authors: AuthorGate;
  readonly firer: TriggerFirer;
  readonly ledger: SeenLedger;
}

/** The id of the source of a trigger of a binding: stable while the binding and its list stay. */
export function codeHostSourceId(binding: WorkflowBindingRecord, parsed: ParsedTrigger): string {
  return `${binding.id}#${String(parsed.index)}:${parsed.trigger.type}`;
}

export function codeHostSource(
  deps: CodeHostSourceDeps,
  binding: WorkflowBindingRecord,
  parsed: ParsedTrigger,
): PollSource {
  return {
    id: codeHostSourceId(binding, parsed),
    poll: async () => {
      switch (parsed.trigger.type) {
        case 'code_host.issue_opened':
        case 'code_host.issue_labeled':
          await lookAtIssues(deps, binding, parsed.trigger);
          return;
        case 'code_host.pr_opened':
        case 'code_host.ci_failed':
          await lookAtPullRequests(deps, binding, parsed.trigger);
          return;
        case 'event':
          return;
      }
    },
  };
}

async function lookAtIssues(
  deps: CodeHostSourceDeps,
  binding: WorkflowBindingRecord,
  trigger: Extract<BindingTrigger, { type: 'code_host.issue_opened' | 'code_host.issue_labeled' }>,
): Promise<void> {
  if (deps.tracker === undefined) {
    throw new AdapterUnavailable('there is no issue tracker for the issue triggers');
  }
  const repo = await deps.repoOf(binding.scenarioId);
  const wanted = trigger.type === 'code_host.issue_labeled' ? trigger.filter.label : undefined;
  const labeled = wanted !== undefined;
  const filter = trigger.filter;
  const required = [...(filter?.labels ?? []), ...(labeled ? [wanted] : [])];
  const issues = await deps.tracker.listIssues({
    repo,
    state: 'open',
    since: binding.createdAt,
    limit: deps.settings().poll.limit,
    ...(required.length === 0 ? {} : { labels: required }),
  });
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    if (issue.state !== 'open') continue;
    if (labeled ? issue.updatedAt < binding.createdAt : issue.createdAt < binding.createdAt) {
      continue;
    }
    if (!labelsFit(issue.labels, filter)) continue;
    const label = wanted?.toLowerCase();
    if (label !== undefined && !issue.labels.some((have) => have.toLowerCase() === label)) continue;
    const key =
      label === undefined
        ? `issue_opened:${String(issue.number)}`
        : `issue_labeled:${String(issue.number)}:${label}`;
    await handle(deps, binding, repo, issue.author, {
      binding,
      triggerType: trigger.type,
      key,
      number: issue.number,
      inputName: 'issue',
    });
  }
}

async function lookAtPullRequests(
  deps: CodeHostSourceDeps,
  binding: WorkflowBindingRecord,
  trigger: Extract<BindingTrigger, { type: 'code_host.pr_opened' | 'code_host.ci_failed' }>,
): Promise<void> {
  if (deps.pullRequests === undefined) {
    throw new AdapterUnavailable(
      'the code host has no way to list pull requests for the pull request triggers',
    );
  }
  const repo = await deps.repoOf(binding.scenarioId);
  const pulls = await deps.pullRequests.listOpen({
    repo,
    since: binding.createdAt,
    limit: deps.settings().poll.limit,
  });
  for (const pull of [...pulls].sort((a, b) => a.number - b.number)) {
    if (!labelsFit(pull.labels, trigger.filter)) continue;
    if (trigger.type === 'code_host.pr_opened') {
      if (pull.createdAt < binding.createdAt) continue;
      await handle(deps, binding, repo, pull.author, {
        binding,
        triggerType: trigger.type,
        key: `pr_opened:${String(pull.number)}`,
        number: pull.number,
        inputName: 'pr',
      });
      continue;
    }
    if (pull.updatedAt < binding.createdAt) continue;
    await lookAtCi(deps, binding, repo, pull, trigger);
  }
}

async function lookAtCi(
  deps: CodeHostSourceDeps,
  binding: WorkflowBindingRecord,
  repo: string,
  pull: PullRequestSummary,
  trigger: BindingTrigger,
): Promise<void> {
  // The sha of the listing decides whether the CI of the head was dealt with: no call to the host.
  if (await deps.ledger.has(binding.id, `ci_failed:${String(pull.number)}:${pull.headSha}`)) return;
  if (deps.ci === undefined) {
    throw new AdapterUnavailable('there is no code host to read the CI of the pull requests');
  }
  const ci = await deps.ci.fetchCiLog({ repo, number: pull.number, maxChars: 1 });
  if (!ci.runs.some(isFailedCiRun)) return;
  await handle(deps, binding, repo, pull.author, {
    binding,
    triggerType: trigger.type,
    key: `ci_failed:${String(pull.number)}:${ci.headSha}`,
    number: pull.number,
    inputName: 'pr',
  });
}

/** The common end of an item: not seen before, from an allowed author, then the firer. */
async function handle(
  deps: CodeHostSourceDeps,
  binding: WorkflowBindingRecord,
  repo: string,
  author: string,
  item: TriggerItem,
): Promise<void> {
  if (await deps.ledger.has(binding.id, item.key)) return;
  const verdict = await deps.authors.check(repo, author);
  if (!verdict.allowed) {
    await deps.firer.drop(item, 'author', verdict.detail);
    return;
  }
  await deps.firer.fire(item);
}
