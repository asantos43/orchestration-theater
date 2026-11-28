// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import type { CiLog, FetchCiLogOptions, JsonObject, WorkflowBindingRecord } from '@otheater/core';
import { EVENT_TYPE_PATTERN } from '@otheater/core';
import { z } from 'zod';

/**
 * What the triggers of the workflow bindings share (docs/24 section 8; plan of Phase 11b, P6): the
 * shape of a trigger as a binding writes it, the narrow ports the polling needs from the code
 * host, and the names of the things a firing leaves behind (the run id and the key of an item).
 * Every shape below that docs/24 does not give is [proposta].
 */

/** The trigger types a binding may ask for. */
export const WORKFLOW_TRIGGER_TYPES = [
  'event',
  'code_host.issue_opened',
  'code_host.issue_labeled',
  'code_host.pr_opened',
  'code_host.ci_failed',
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

const labelList = z.array(z.string().min(1).max(100)).max(20);

/** The filters every code host trigger takes: the labels the item must have, and one of which it must. */
const codeHostFilter = z.strictObject({
  /** Every one of these labels. */
  labels: labelList.optional(),
  /** At least one of these labels. */
  labels_any: labelList.optional(),
});

/**
 * A trigger of a binding: `{ type, filter }` as in the definitions (`TriggerSchema` of the
 * workflows package), with the filter of each type checked here.
 *
 * - `event`: `filter.name` is the type of the event (`workflow.run.finished`, `plugin.<id>.<name>`).
 * - `code_host.issue_opened`: an open issue that appeared after the binding.
 * - `code_host.issue_labeled`: an open issue that has the label `filter.label`.
 * - `code_host.pr_opened`: an open pull request that appeared after the binding.
 * - `code_host.ci_failed`: an open pull request whose head has a failed CI run.
 *
 * [proposta] The author filter is the key `workflows.triggers.authors`, not a field of the trigger:
 * one place to say who may start a run from third-party text.
 */
export const BindingTriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('event'),
    filter: z.strictObject({ name: z.string().max(128).regex(EVENT_TYPE_PATTERN) }),
  }),
  z.strictObject({
    type: z.literal('code_host.issue_opened'),
    filter: codeHostFilter.optional(),
  }),
  z.strictObject({
    type: z.literal('code_host.issue_labeled'),
    filter: codeHostFilter.extend({ label: z.string().min(1).max(100) }),
  }),
  z.strictObject({ type: z.literal('code_host.pr_opened'), filter: codeHostFilter.optional() }),
  z.strictObject({ type: z.literal('code_host.ci_failed'), filter: codeHostFilter.optional() }),
]);
export type BindingTrigger = z.infer<typeof BindingTriggerSchema>;

/** A trigger of a binding with its place in the list (what the events and the sources name). */
export interface ParsedTrigger {
  readonly index: number;
  readonly trigger: BindingTrigger;
}

/** What went wrong with a trigger a binding wrote: its place and why. */
export interface InvalidTrigger {
  readonly index: number;
  readonly type: string;
  readonly detail: string;
}

/** The triggers of a binding that this daemon understands, and the ones it does not. */
export function parseBindingTriggers(binding: Pick<WorkflowBindingRecord, 'triggers'>): {
  readonly valid: readonly ParsedTrigger[];
  readonly invalid: readonly InvalidTrigger[];
} {
  const valid: ParsedTrigger[] = [];
  const invalid: InvalidTrigger[] = [];
  binding.triggers.forEach((raw: JsonObject, index) => {
    const parsed = BindingTriggerSchema.safeParse(raw);
    if (parsed.success) {
      valid.push({ index, trigger: parsed.data });
      return;
    }
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join('.') ?? '';
    invalid.push({
      index,
      type: typeof raw.type === 'string' ? raw.type.slice(0, 64) : 'unknown',
      detail: `${where === '' ? 'the trigger' : where}: ${issue?.message ?? 'does not fit'}`.slice(
        0,
        400,
      ),
    });
  });
  return { valid, invalid };
}

// ---------------------------------------------------------------------------------------------
// The ports the polling needs beyond the ones of the core

/** One open pull request, as much as the triggers read of it. */
export interface PullRequestSummary {
  readonly number: number;
  /** Login of who opened it. */
  readonly author: string;
  /** Names of the labels. */
  readonly labels: readonly string[];
  /** Sha of the head commit. */
  readonly headSha: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  /** ms since the epoch. */
  readonly updatedAt: number;
}

/**
 * Lists the open pull requests of a repository, newest first. [proposta] The `CodeHost` port of
 * today (0.2.0) has no way to list pull requests (it finds one by branch and fetches one by
 * number), so the `pr_opened` and `ci_failed` triggers take this narrow port; the daemon wires it
 * with an adapter later (a `listPullRequests` in the port is the follow-up). Without it those two
 * triggers fail their look with a clear message and follow `workflows.triggers.poll.on_error`.
 */
export interface PullRequestLister {
  listOpen(opts: {
    readonly repo: string;
    /** Only pull requests updated at or after this time (ms since the epoch). */
    readonly since: number;
    readonly limit: number;
  }): Promise<readonly PullRequestSummary[]>;
}

/**
 * Tells whether a login has a role in the repository (a collaborator). [proposta] The ports of
 * today do not answer that; without it `workflows.triggers.authors: collaborators` allows nobody.
 */
export interface CollaboratorCheck {
  isCollaborator(opts: { readonly repo: string; readonly login: string }): Promise<boolean>;
}

/** What `ci_failed` reads of the code host. */
export interface CiReader {
  fetchCiLog(opts: FetchCiLogOptions): Promise<CiLog>;
}

// ---------------------------------------------------------------------------------------------
// Names

/** The first part of the id of every run a trigger starts; the end is a hash of the item. */
export function runIdPrefix(bindingId: string): string {
  return `trg-${bindingId}-`;
}

/**
 * The id of the run a binding starts for an item. It is a function of the two, so the same item of
 * the same binding always gives the same id: starting it twice is a `Conflict`, which the firing
 * reads as "already fired" (the once-only guarantee holds even if the ledger lost the mark in a
 * crash). The prefix tells which runs are the binding's (the ones that count for `concurrency`).
 */
export function triggerRunId(bindingId: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${runIdPrefix(bindingId)}${hash}`;
}

/** Whether a label list satisfies the `labels` and `labels_any` of a filter. */
export function labelsFit(
  have: readonly string[],
  filter:
    | {
        readonly labels?: readonly string[] | undefined;
        readonly labels_any?: readonly string[] | undefined;
      }
    | undefined,
): boolean {
  const lower = new Set(have.map((label) => label.toLowerCase()));
  const all = filter?.labels ?? [];
  const any = filter?.labels_any ?? [];
  if (!all.every((label) => lower.has(label.toLowerCase()))) return false;
  return any.length === 0 || any.some((label) => lower.has(label.toLowerCase()));
}
