// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import {
  AdapterUnavailable,
  attemptBranch,
  type CodeHost,
  Conflict,
  DEFAULT_REMOTE,
  InvalidInput,
  type JsonObject,
  NotFound,
  type Script,
  type Store,
  type Vcs,
  type VcsHistory,
  type VcsMerge,
  hasErrorCode,
  supportsBranchDelete,
  supportsRebase,
  integrationBranch,
  playBranch,
  supportsHistory,
  supportsMerge,
  topologicalLayers,
  withIdempotencyTrailer,
} from '@otheater/core';
import {
  buildDaemonEvent,
  type DaemonEventPayloads,
  type DeliveryCompletedPayload,
  type WorkspaceIntegratedPayload,
  type WorkspaceIntegrationFailedPayload,
} from '@otheater/protocol';
import { type EffectOutcome, runEffect } from './effects.js';
import {
  type DeliveryDecision,
  type DeliveryMode,
  type DeliveryRequest,
  resolveDeliveryMode,
} from './delivery-policy.js';
import {
  GIT_COMMIT_EFFECT,
  GIT_PUSH_EFFECT,
  MERGE_BASE_EFFECT,
  OPEN_PR_EFFECT,
  verifyGitCommit,
  verifyGitPush,
  verifyMergeBase,
  verifyOpenPr,
} from './verifiers.js';

export interface WorkspaceOptions {
  readonly store: Pick<Store, 'events' | 'sideEffects'>;
  /** Needs the optional capabilities `VcsMerge` and `VcsHistory` (`GitVcs` has both). */
  readonly vcs: Vcs;
  readonly codeHost: CodeHost;
  /**
   * Where the worktrees the Workspace creates live (`<root>/<play>/base`, `<root>/<play>/integration`).
   * Absolute path, normally under the data folder. [proposta]
   */
  readonly worktreeRoot: string;
}

/** One approved attempt to integrate: the Director's reading of the review (`APPROVED`). */
export interface ApprovedAttempt {
  readonly demandId: string;
  readonly attempt: number;
}

export interface IntegrateInput {
  readonly repo: string;
  readonly playId: string;
  /** The scenario of the play: goes in the events, so the SSE filter `scenario` sees them (N172). */
  readonly scenarioId: string;
  readonly script: Pick<Script, 'demands'>;
  readonly approved: readonly ApprovedAttempt[];
  /**
   * Which build of the integration branch this is (default 1). A new script rebuilds the branch
   * from the base ({@link Workspace.resetIntegration}); the merges of the new build need keys of
   * their own, or the registry would replay the old ones and merge nothing. [proposta]
   */
  readonly round?: number;
}

/** What {@link Workspace.mergeBase} did. */
export type BaseMergeResult =
  | {
      readonly kind: 'merged' | 'up_to_date';
      /** Head of the integration branch afterwards. */
      readonly head: string;
      /** The worktree where the integration branch is checked out. */
      readonly worktree: string;
      /** The sha of the play base that was merged. */
      readonly baseSha: string;
    }
  | {
      readonly kind: 'conflict';
      readonly worktree: string;
      readonly baseSha: string;
      readonly conflictFiles: readonly string[];
    }
  | { readonly kind: 'ambiguous'; readonly key: string; readonly reason: string };

export interface IntegratedAttempt {
  readonly demandId: string;
  readonly attempt: number;
  readonly branch: string;
  /** Head of the attempt branch when it was merged. */
  readonly sha: string;
  /** `up_to_date`: the attempt had nothing the integration branch lacked. */
  readonly outcome: 'merged' | 'up_to_date';
}

export type IntegrationResult =
  | {
      readonly kind: 'integrated';
      readonly branch: string;
      /** The worktree where the integration branch is checked out. */
      readonly worktree: string;
      readonly head: string;
      readonly merged: readonly IntegratedAttempt[];
    }
  /**
   * A merge conflicted. In the architecture (5.4, 5.5) that is a script failure: the Director
   * takes it as such and decides (new demand, new script). Nothing of the conflicting attempt is
   * in the integration branch.
   */
  | {
      readonly kind: 'script_failure';
      readonly cause: 'merge_conflict';
      readonly demandId: string;
      readonly attempt: number;
      /** The attempt branch that conflicted. */
      readonly branch: string;
      readonly integrationBranch: string;
      readonly conflictFiles: readonly string[];
      /** Demands merged before the conflict, in order. */
      readonly mergedSoFar: readonly string[];
    }
  /** The verifier of an earlier, unfinished merge could not tell whether it happened. */
  | {
      readonly kind: 'ambiguous';
      readonly demandId: string;
      readonly attempt: number;
      readonly key: string;
      readonly reason: string;
    };

/** A file the delivery commits to the integration branch before it is pushed (the changelog). */
export interface DeliveryChange {
  /** Path relative to the root of the repository. */
  readonly file: string;
  /** The whole new text of the file. */
  readonly content: string;
  /** First line of the commit. */
  readonly message: string;
}

export interface DeliverInput {
  readonly repo: string;
  readonly playId: string;
  /** The scenario of the play: goes in `delivery.completed` (N172). */
  readonly scenarioId: string;
  /** Branch the work is delivered to (the project's base, on the remote). */
  readonly base: string;
  /** Default {@link DEFAULT_REMOTE}. */
  readonly remote?: string;
  /** Title of the PR. */
  readonly title: string;
  /** Text of the PR; the mode used and who asked for it are added after it. */
  readonly body?: string;
  /** Message of the merge commit of `direct_merge`. Default `Deliver play <id>`. */
  readonly mergeMessage?: string;
  /**
   * Looks at the integration worktree and says what the delivery still commits to it, or nothing.
   * Runs before the push; the commit is a side effect keyed `<play>:deliver_prepare[:r<round>]`.
   * Called again after a crash, it answers `undefined` once the commit is in.
   */
  readonly prepare?: (worktree: string) => Promise<DeliveryChange | undefined>;
  /** The round of the play (a new script is a new round), for the key of the `prepare` commit. */
  readonly round?: number;
  /** See {@link DeliveryPolicyInput.requested}. */
  readonly requested?: DeliveryRequest;
  /** `delivery.mode`. */
  readonly configMode: DeliveryMode;
  /** `delivery.allow_direct_merge`. */
  readonly allowDirectMerge: boolean;
  /** What the Producer should know: listed in the PR and in `delivery.completed`. [proposta] */
  readonly warnings?: readonly string[];
  /** Someone is looking; with nobody, `ask` becomes `pr`. */
  readonly attended: boolean;
}

export type DeliveryResult =
  | {
      readonly kind: 'delivered';
      readonly mode: 'pr' | 'direct_merge';
      readonly decision: DeliveryDecision;
      readonly branch: string;
      readonly base: string;
      readonly pushedSha: string;
      readonly pullRequest?: { readonly number: number; readonly url: string };
      readonly mergeSha?: string;
    }
  /** The Director must ask the Producer (`pr` or `direct_merge`) and call `deliver` again. */
  | {
      readonly kind: 'ask_producer';
      readonly decision: DeliveryDecision;
      readonly options: readonly ['pr', 'direct_merge'];
      readonly recommended: 'pr';
    }
  /** The verifier of an earlier, unfinished step could not tell whether it happened. */
  | {
      readonly kind: 'ambiguous';
      readonly step: 'prepare' | 'push' | 'pull_request' | 'merge';
      readonly key: string;
      readonly reason: string;
    };

/**
 * The Workspace of a play (architecture 5.5): the branch of the play, the integration of the
 * approved attempts and the delivery (a PR by default). It sits on the `Vcs` port for what is
 * local and on the `CodeHost` port for what is remote; every effect that leaves the machine, and
 * the merge commits, are side effects of the registry (5.21): the intent is written first, then
 * the effect, then its resolution, and a repetition checks before it acts, so nothing happens twice.
 *
 * Not here (the effects of the play wire it): who calls it and when, and the removal of the
 * worktrees after the delivery. The integration branch is rebuilt from the base for a new script
 * (`resetIntegration`, with a `round` in the keys) and updated when the base moves (`moveBase`,
 * `mergeBase`). [proposta]
 */
export class Workspace {
  readonly #store: Pick<Store, 'events' | 'sideEffects'>;
  readonly #vcs: Vcs & VcsMerge & VcsHistory;
  readonly #codeHost: CodeHost;
  readonly #worktreeRoot: string;

  constructor(options: WorkspaceOptions) {
    if (!supportsMerge(options.vcs) || !supportsHistory(options.vcs)) {
      throw new AdapterUnavailable(
        `The Vcs adapter ${options.vcs.id} cannot merge or answer history queries, and the Workspace needs both`,
      );
    }
    this.#store = options.store;
    this.#vcs = options.vcs;
    this.#codeHost = options.codeHost;
    this.#worktreeRoot = options.worktreeRoot;
  }

  /**
   * Creates `play/<id>/base` from `base` (a ref of the project) and returns its sha. Repeating it
   * returns the branch that is there, whatever `base` is by now: the play keeps the base it
   * started from.
   */
  async createPlayBase(input: {
    readonly repo: string;
    readonly playId: string;
    readonly base: string;
  }): Promise<string> {
    const branch = playBranch(input.playId);
    try {
      return await this.#vcs.resolveRef(input.repo, branch);
    } catch (error) {
      if (!hasErrorCode(error, 'NOT_FOUND')) throw error;
    }
    // A branch needs a worktree to be created; the worktree goes away and the branch stays.
    const path = join(this.#worktreeRoot, input.playId, 'base');
    const created = await this.#vcs.createWorktree({
      repo: input.repo,
      path,
      branch,
      base: input.base,
    });
    await this.#vcs.removeWorktree(created.path);
    return created.head;
  }

  /**
   * Merges the approved attempts into `play/<id>/integration`, in the order of the script
   * (`topologicalLayers`), each as a side effect keyed `<play>:integrate:<demand>:<attempt>`. The
   * first conflict stops the integration and is reported as a script failure; what was merged
   * before it stays.
   */
  async integrate(input: IntegrateInput): Promise<IntegrationResult> {
    const ordered = orderApproved(input.script, input.approved);
    const branch = integrationBranch(input.playId);
    const worktree = await this.#integrationWorktree(input.repo, input.playId);

    const merged: IntegratedAttempt[] = [];
    let replayedOnly = true;
    for (const { demandId, attempt } of ordered) {
      const source = attemptBranch(input.playId, demandId, attempt);
      const sourceSha = await this.#vcs.resolveRef(input.repo, source);
      const key = `${input.playId}:integrate:${demandId}:${String(attempt)}${roundSuffix(input.round)}`;
      const outcome = await runEffect(this.#store.sideEffects, {
        key,
        type: GIT_COMMIT_EFFECT,
        target: branch,
        params: { repo: input.repo, branch },
        execute: async (effectiveKey) => {
          const result = await this.#vcs.merge(worktree, source, {
            message: withIdempotencyTrailer(
              `Integrate ${demandId} (attempt ${String(attempt)})`,
              effectiveKey,
            ),
          });
          return result.kind === 'conflict'
            ? { outcome: 'conflict', files: [...result.files] }
            : { outcome: result.kind, sha: result.sha };
        },
        verify: (record) => verifyGitCommit(this.#deps(), record),
      });
      if (outcome.kind === 'ambiguous') {
        return { kind: 'ambiguous', demandId, attempt, key: outcome.key, reason: outcome.reason };
      }
      if (outcome.origin !== 'replayed') replayedOnly = false;

      if (outcome.result.outcome === 'conflict') {
        const failure = {
          kind: 'script_failure',
          cause: 'merge_conflict',
          demandId,
          attempt,
          branch: source,
          integrationBranch: branch,
          conflictFiles: stringList(outcome.result.files),
          mergedSoFar: merged.map((entry) => entry.demandId),
        } as const;
        if (!replayedOnly) {
          await this.#emit(input.playId, input.scenarioId, 'workspace.integration_failed', {
            playId: input.playId,
            scenarioId: input.scenarioId,
            branch,
            cause: failure.cause,
            demandId,
            attempt,
            conflictFiles: [...failure.conflictFiles],
            mergedSoFar: [...failure.mergedSoFar],
          } satisfies WorkspaceIntegrationFailedPayload);
        }
        return failure;
      }
      merged.push({
        demandId,
        attempt,
        branch: source,
        sha: sourceSha,
        outcome: outcome.result.outcome === 'up_to_date' ? 'up_to_date' : 'merged',
      });
    }

    const head = await this.#vcs.headOf(worktree);
    if (!replayedOnly) {
      await this.#emit(input.playId, input.scenarioId, 'workspace.integrated', {
        playId: input.playId,
        scenarioId: input.scenarioId,
        branch,
        head,
        merged: merged.map(({ demandId, attempt, branch: from, sha }) => ({
          demandId,
          attempt,
          branch: from,
          sha,
        })),
      } satisfies WorkspaceIntegratedPayload);
    }
    return { kind: 'integrated', branch, worktree, head, merged };
  }

  /**
   * Moves `play/<id>/base` onto `onto` (the project's base, as the play sees it by now), so the
   * attempts opened after the move start from the new base (N83, "update"). The play base has no
   * commits of its own, so the rebase is a fast-forward. [proposta] Returns the new sha. Needs the
   * optional capability `VcsRebase`, and no worktree can have the branch checked out.
   */
  async moveBase(input: {
    readonly repo: string;
    readonly playId: string;
    readonly onto: string;
  }): Promise<string> {
    if (!supportsRebase(this.#vcs)) {
      throw new AdapterUnavailable(
        `The Vcs adapter ${this.#vcs.id} cannot rebase, and moving the base of a play needs it`,
      );
    }
    const outcome = await this.#vcs.rebaseBranch(input.repo, playBranch(input.playId), input.onto);
    if (outcome.kind === 'conflict') {
      throw new Conflict(
        `The base of the play ${input.playId} cannot move onto ${input.onto}: ${outcome.files.join(', ')}`,
      );
    }
    return outcome.sha;
  }

  /**
   * Merges `play/<id>/base` (as it is now) into the integration branch, as a side effect keyed
   * `<play>:drift:r<round>:<sha of the base>`: the base moved while the play ran (N83). A base
   * the integration already has is `up_to_date`. A conflict leaves the integration as it was and
   * names the files. Calling it again for the same base and round gives the same answer.
   */
  async mergeBase(input: {
    readonly repo: string;
    readonly playId: string;
    readonly round?: number;
  }): Promise<BaseMergeResult> {
    const { repo, playId } = input;
    const source = playBranch(playId);
    const branch = integrationBranch(playId);
    const baseSha = await this.#vcs.resolveRef(repo, source);
    const worktree = await this.#integrationWorktree(repo, playId);
    const outcome = await runEffect(this.#store.sideEffects, {
      key: `${playId}:drift:${roundLabel(input.round)}:${baseSha}`,
      type: GIT_COMMIT_EFFECT,
      target: branch,
      params: { repo, branch },
      execute: async (effectiveKey) => {
        const result = await this.#vcs.merge(worktree, source, {
          message: withIdempotencyTrailer(
            `Update to the base (${baseSha.slice(0, 12)})`,
            effectiveKey,
          ),
        });
        return result.kind === 'conflict'
          ? { outcome: 'conflict', files: [...result.files] }
          : { outcome: result.kind, sha: result.sha };
      },
      verify: (record) => verifyGitCommit(this.#deps(), record),
    });
    if (outcome.kind === 'ambiguous') {
      return { kind: 'ambiguous', key: outcome.key, reason: outcome.reason };
    }
    if (outcome.result.outcome === 'conflict') {
      return {
        kind: 'conflict',
        worktree,
        baseSha,
        conflictFiles: stringList(outcome.result.files),
      };
    }
    return {
      kind: outcome.result.outcome === 'up_to_date' ? 'up_to_date' : 'merged',
      head: await this.#vcs.headOf(worktree),
      worktree,
      baseSha,
    };
  }

  /**
   * Drops the integration branch and its worktree, so the next {@link Workspace.integrate}
   * rebuilds it from `play/<id>/base` (a new script, N84). Returns whether there was one. The
   * attempt branches are not touched. [proposta]
   */
  async resetIntegration(input: {
    readonly repo: string;
    readonly playId: string;
  }): Promise<boolean> {
    const branch = integrationBranch(input.playId);
    const known = (await this.#vcs.listWorktrees(input.repo)).find(
      (entry) => entry.branch === branch,
    );
    if (known !== undefined) {
      await this.#vcs.removeWorktree(known.path, { force: true, deleteBranch: true });
      return true;
    }
    try {
      await this.#vcs.resolveRef(input.repo, branch);
    } catch (error) {
      if (hasErrorCode(error, 'NOT_FOUND')) return false;
      throw error;
    }
    if (!supportsBranchDelete(this.#vcs)) {
      throw new AdapterUnavailable(
        `The Vcs adapter ${this.#vcs.id} cannot delete the branch ${branch}`,
      );
    }
    await this.#vcs.deleteBranch(input.repo, branch);
    return true;
  }

  /**
   * Delivers `play/<id>/integration` to `base` under the delivery policy (5.5): push the branch,
   * then open the PR (`pr`, the default) or merge on the remote (`direct_merge`). `ask` returns
   * `ask_producer` and does nothing. Each remote step is a side effect with its own key, so
   * calling `deliver` again never pushes the same head twice nor requests a second PR.
   */
  async deliver(input: DeliverInput): Promise<DeliveryResult> {
    const decision = resolveDeliveryMode({
      ...(input.requested === undefined ? {} : { requested: input.requested }),
      configMode: input.configMode,
      allowDirectMerge: input.allowDirectMerge,
      attended: input.attended,
    });
    if (decision.mode === 'ask') {
      return { kind: 'ask_producer', decision, options: ['pr', 'direct_merge'], recommended: 'pr' };
    }

    const { repo, playId, base } = input;
    const remote = input.remote ?? DEFAULT_REMOTE;
    const branch = integrationBranch(playId);
    const prepared = await this.#prepareDelivery(input);
    if (prepared !== undefined) return prepared;
    const head = await this.#vcs.resolveRef(repo, branch);

    const pushed = await runEffect(this.#store.sideEffects, {
      key: `${playId}:push:${branch}@${head}`,
      type: GIT_PUSH_EFFECT,
      target: branch,
      params: { repo, branch, remote, sha: head },
      execute: async () => ({ sha: await this.#codeHost.pushRef({ repo, branch, remote }) }),
      verify: (record) => verifyGitPush(this.#deps(), record),
    });
    if (pushed.kind === 'ambiguous') return ambiguous('push', pushed);
    const pushedSha = requireText(pushed.result, 'sha');

    const common = { repo, branch, base, remote };
    let final: Extract<EffectOutcome, { kind: 'done' }>;
    let pullRequest: { number: number; url: string } | undefined;
    let mergeSha: string | undefined;
    if (decision.mode === 'direct_merge') {
      const merged = await runEffect(this.#store.sideEffects, {
        key: `${playId}:merge:${base}:${head}`,
        type: MERGE_BASE_EFFECT,
        target: base,
        params: { repo, head: branch, base, remote, sha: head },
        execute: async () => ({
          sha: (
            await this.#codeHost.mergeBranch({
              repo,
              head: branch,
              base,
              remote,
              message: input.mergeMessage ?? `Deliver play ${playId}`,
            })
          ).sha,
        }),
        verify: (record) => verifyMergeBase(this.#deps(), record),
      });
      if (merged.kind === 'ambiguous') return ambiguous('merge', merged);
      final = merged;
      mergeSha = requireText(merged.result, 'sha');
    } else {
      const opened = await runEffect(this.#store.sideEffects, {
        key: `${playId}:pr:${branch}:${base}`,
        type: OPEN_PR_EFFECT,
        target: `${branch} -> ${base}`,
        params: { repo, head: branch, base, remote },
        execute: () => this.#openPullRequest({ ...common, input, decision }),
        verify: (record) => verifyOpenPr(this.#deps(), record),
      });
      if (opened.kind === 'ambiguous') return ambiguous('pull_request', opened);
      final = opened;
      pullRequest = {
        number: requireNumber(opened.result, 'number'),
        url: requireText(opened.result, 'url'),
      };
    }

    // The event says the delivery happened; a repetition that only replays records says nothing.
    if (final.origin !== 'replayed' || pushed.origin !== 'replayed') {
      await this.#emit(playId, input.scenarioId, 'delivery.completed', {
        playId,
        scenarioId: input.scenarioId,
        mode: decision.mode,
        requestedMode: decision.requestedMode,
        requestedBy: decision.requestedBy,
        downgraded: decision.downgraded,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        branch,
        base,
        pushedSha,
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(mergeSha === undefined ? {} : { mergeSha }),
        ...(input.warnings === undefined || input.warnings.length === 0
          ? {}
          : { warnings: [...input.warnings] }),
      } satisfies DeliveryCompletedPayload);
    }
    return {
      kind: 'delivered',
      mode: decision.mode,
      decision,
      branch,
      base,
      pushedSha,
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(mergeSha === undefined ? {} : { mergeSha }),
    };
  }

  /**
   * The `prepare` step of a delivery: the commit of what the caller adds to the integration branch
   * (the changelog) before the push. `undefined` when it went well or there was nothing to add;
   * else the answer `deliver` gives (the verifier could not tell whether an earlier commit
   * happened).
   */
  async #prepareDelivery(input: DeliverInput): Promise<DeliveryResult | undefined> {
    if (input.prepare === undefined) return undefined;
    const { repo, playId } = input;
    const branch = integrationBranch(playId);
    const worktree = await this.#integrationWorktree(repo, playId);
    const change = await input.prepare(worktree);
    if (change === undefined) return undefined;
    const target = normalize(change.file);
    if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) {
      throw new InvalidInput(`The file "${change.file}" is not inside the repository`);
    }
    const outcome = await runEffect(this.#store.sideEffects, {
      key: `${playId}:deliver_prepare${roundSuffix(input.round)}`,
      type: GIT_COMMIT_EFFECT,
      target: branch,
      params: { repo, branch },
      execute: async (effectiveKey) => {
        const path = join(worktree, target);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, change.content);
        const sha = await this.#vcs.commitAll(
          worktree,
          withIdempotencyTrailer(change.message, effectiveKey),
        );
        return sha === undefined ? { outcome: 'up_to_date' } : { outcome: 'merged', sha };
      },
      verify: (record) => verifyGitCommit(this.#deps(), record),
    });
    return outcome.kind === 'ambiguous' ? ambiguous('prepare', outcome) : undefined;
  }

  /** Adopts the PR that is already open for the branch (a crash after the host created it), else opens one. */
  async #openPullRequest(args: {
    readonly repo: string;
    readonly branch: string;
    readonly base: string;
    readonly remote: string;
    readonly input: DeliverInput;
    readonly decision: DeliveryDecision;
  }): Promise<JsonObject> {
    const { repo, branch, base, remote } = args;
    const existing = await this.#codeHost.findPullRequest({
      repo,
      head: branch,
      base,
      remote,
      states: ['open'],
    });
    const pr =
      existing ??
      (await this.#codeHost.openPullRequest({
        repo,
        head: branch,
        base,
        remote,
        title: args.input.title,
        body: pullRequestBody(args.input.body, args.decision, args.input.warnings),
      }));
    return { number: pr.number, url: pr.url, state: pr.state };
  }

  /** The worktree where the integration branch is checked out; created on the first call. */
  async #integrationWorktree(repo: string, playId: string): Promise<string> {
    const branch = integrationBranch(playId);
    const base = playBranch(playId);
    try {
      await this.#vcs.resolveRef(repo, base);
    } catch (error) {
      if (hasErrorCode(error, 'NOT_FOUND')) {
        throw new NotFound(`The play ${playId} has no base branch (${base}); create it first`, {
          cause: error,
        });
      }
      throw error;
    }
    const known = (await this.#vcs.listWorktrees(repo)).find((entry) => entry.branch === branch);
    if (known !== undefined) return known.path;
    try {
      await this.#vcs.resolveRef(repo, branch);
      throw new Conflict(
        `The branch ${branch} exists but is not checked out in any worktree; the Workspace does not rebuild it`,
      );
    } catch (error) {
      if (!hasErrorCode(error, 'NOT_FOUND')) throw error;
    }
    const created = await this.#vcs.createWorktree({
      repo,
      path: join(this.#worktreeRoot, playId, 'integration'),
      branch,
      base,
    });
    return created.path;
  }

  #deps(): { vcs: Vcs & VcsHistory; codeHost: CodeHost } {
    return { vcs: this.#vcs, codeHost: this.#codeHost };
  }

  async #emit<
    T extends 'workspace.integrated' | 'workspace.integration_failed' | 'delivery.completed',
  >(playId: string, scenarioId: string, type: T, payload: DaemonEventPayloads[T]): Promise<void> {
    // N172: `scenarioId` is also in the envelope, which is what the SSE filter `scenario` reads.
    await this.#store.events.append({ ...buildDaemonEvent(type, payload), playId, scenarioId });
  }
}

/** The approved attempts in the order of the script's layers; rejects what makes no sense. */
function orderApproved(
  script: Pick<Script, 'demands'>,
  approved: readonly ApprovedAttempt[],
): ApprovedAttempt[] {
  if (approved.length === 0) throw new InvalidInput('There is no approved attempt to integrate');
  const byDemand = new Map<string, ApprovedAttempt>();
  for (const entry of approved) {
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1) {
      throw new InvalidInput(
        `Invalid attempt number for ${entry.demandId}: ${String(entry.attempt)}`,
      );
    }
    if (byDemand.has(entry.demandId)) {
      throw new InvalidInput(`Two approved attempts for the demand ${entry.demandId}`);
    }
    byDemand.set(entry.demandId, entry);
  }
  const inScript = new Set(script.demands.map((demand) => demand.id));
  for (const demandId of byDemand.keys()) {
    if (!inScript.has(demandId)) {
      throw new InvalidInput(`The demand ${demandId} is not in the script`);
    }
  }
  return topologicalLayers(script)
    .flat()
    .flatMap((demandId) => {
      const entry = byDemand.get(demandId);
      return entry === undefined ? [] : [entry];
    });
}

/** Round 1 keeps the key the registry has always had; later rounds add `:r<round>`. */
function roundSuffix(round: number | undefined): string {
  return round === undefined || round <= 1 ? '' : `:r${String(round)}`;
}

function roundLabel(round: number | undefined): string {
  return `r${String(round ?? 1)}`;
}

function pullRequestBody(
  body: string | undefined,
  decision: DeliveryDecision,
  warnings: readonly string[] = [],
): string {
  const lines = [
    `OTheater delivery: mode \`${decision.mode}\`, requested \`${decision.requestedMode}\` by ${decision.requestedBy}.`,
  ];
  if (decision.reason !== undefined) lines.push(`Downgraded to a PR: ${decision.reason}.`);
  if (warnings.length > 0) lines.push('', '**Warnings**', ...warnings.map((line) => `- ${line}`));
  const head = body?.trim() ?? '';
  return head === '' ? lines.join('\n') : `${head}\n\n---\n${lines.join('\n')}`;
}

function ambiguous(
  step: 'prepare' | 'push' | 'pull_request' | 'merge',
  outcome: { readonly key: string; readonly reason: string },
): DeliveryResult {
  return { kind: 'ambiguous', step, key: outcome.key, reason: outcome.reason };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requireText(result: JsonObject, field: string): string {
  const value = result[field];
  if (typeof value !== 'string' || value === '') {
    throw new Conflict(`A recorded side effect result has no "${field}"`);
  }
  return value;
}

function requireNumber(result: JsonObject, field: string): number {
  const value = result[field];
  if (typeof value !== 'number') {
    throw new Conflict(`A recorded side effect result has no "${field}"`);
  }
  return value;
}
