// SPDX-License-Identifier: MPL-2.0
import type { CodeHost, IssueTracker } from '@otheater/core';
import type { WorkflowSecuritySettings } from '../../security-config.js';

/**
 * The ports and the settings of the code host steps (plan of Phase 11b, P8), in a file of their own
 * so `steps/types.ts` can name them without an import cycle through `support.ts`.
 */

/** A comment the verifier of a `comment` found on the tracker. */
export interface FoundComment {
  readonly id: string;
  readonly url: string;
}

/**
 * Looks for a comment that carries `marker` on an issue or a pull request, to tell whether a
 * `comment` that was cut off by a crash got to the tracker. [proposta] The `IssueTracker` port of
 * today (0.1.0) has no way to list comments, so the daemon wires this later (a `listComments` in
 * the port is the follow-up); without it a `comment` that was open at a crash cannot be verified, and
 * the step fails with `effect_ambiguous` rather than risk a second comment.
 */
export type CommentFinder = (query: {
  readonly repo: string;
  readonly number: number;
  readonly target: 'issue' | 'pr';
  readonly marker: string;
}) => Promise<FoundComment | undefined>;

/** The ports and the settings of the code host steps. Absent in `StepDeps`: the steps fail with `code_host_unavailable`. */
export interface CodeHostStepDeps {
  readonly codeHost: CodeHost;
  readonly issueTracker: IssueTracker;
  /**
   * The repository of the scenario: the absolute path of a checkout the code host and the tracker
   * serve (the `repo` of their calls). The steps never take it from the inputs of a run.
   */
  readonly repoOf: (scenarioId: string) => string | Promise<string>;
  readonly security: WorkflowSecuritySettings;
  readonly findComment?: CommentFinder | undefined;
}
