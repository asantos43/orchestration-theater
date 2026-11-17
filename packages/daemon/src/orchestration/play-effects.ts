// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AdapterUnavailable,
  assemblePrefix,
  Conflict,
  attemptBranch,
  type AttemptRecord,
  hasErrorCode,
  contractKey,
  type Demand,
  type DecisionRecord,
  type EventEnvelope,
  InvalidInput,
  integrationBranch,
  type JsonValue,
  NotFound,
  parseConventions,
  parseScript,
  PLAN_KEY,
  planOutput,
  playBranch,
  type PromptSource,
  type Registries,
  reviewOutput,
  type RolePolicy,
  type Script,
  scriptOutput,
  SCRIPT_KEY,
  type Store,
  supportsDiff,
  supportsHistory,
  supportsRebase,
  topologicalLayers,
  validateScript,
  type Vcs,
} from '@otheater/core';
import { z } from 'zod';
import type { DaemonConfig, PlayLimits } from '../config.js';
import type { Execution } from '../execution/service.js';
import type { Logger } from '../logger.js';
import type { DataPaths } from '../paths.js';
import {
  restorePlay,
  type PlayEffect,
  type PlayEffects,
  type PlayEffectScope,
  type PlayRunner,
} from '../pipeline/index.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import type { Workspace } from '../workspace/index.js';
import type { DirectorSessions } from './director.js';
import { buildDeliveryArtifacts, changelogModeOf, planChangelog } from '../project/artifacts.js';
import { CarrySchema, carryKey, INTEGRATION_ROUND_KEY, keptDemands, type Carry } from './carry.js';
import { type CarriedWork, clarifyPrompt, judgePrompt, stagePrompt } from './prompts.js';
import { resolveRolePolicy } from './role-policy.js';
import { executorOf, sessionSettingsOf } from './roles.js';

const execFileAsync = promisify(execFile);

/** The kinds of decision rows the effects create (and the handlers and the channel read). */
export const DECISION_KINDS = {
  /** `judge.<point>`: a judgment point the Director settles with `decide`. */
  judgePrefix: 'judge.',
  /** The plan has open questions: the Director asks the Producer and answers with `decide`. */
  clarify: 'clarify',
  /** AWAITING_PRODUCER: the fixed menu; only the Producer answers. */
  menu: 'producer_menu',
  /** A blocking `ask_producer` of the Director; only the Producer answers. */
  question: 'producer_question',
  /**
   * An effect the start-up reconciliation could not settle (5.21): the Producer says whether it
   * happened. [proposta] The kind and the two answers (`done`, `not_done`).
   */
  recovery: 'recovery_effect',
} as const;

/** Most characters of a reason that goes into an event or a prompt. */
const REASON_LIMIT = 1500;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REASON_LIMIT ? trimmed : `${trimmed.slice(0, REASON_LIMIT)}...`;
}

/** What goes to the blackboard: the value is plain data already (it came from zod or JSON). */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The id of the pseudo demand a stage attempt runs under (`REVIEWING_PLAN` is `stage-reviewing-plan`). */
export function stageDemandId(stage: string): string {
  return `stage-${stage.toLowerCase().replaceAll('_', '-')}`;
}

// What the roles send through their `submit_*` tool is validated by the tool itself, with the
// schemas of `@otheater/core` (`planOutput`, `reviewOutput`, `scriptOutput`): the same ones read
// the accepted output back here, so the two cannot drift apart.

/**
 * Reads the accepted output of a stage tool. It cannot fail after the tool accepted it; if it
 * does (a change of schema between the call and now, a hand-written event), the reason of the
 * failure carries what was wrong, not only that something was.
 */
function readStageOutput<T>(schema: z.ZodType<T>, tool: string, output: unknown): T {
  const parsed = schema.safeParse(output);
  if (parsed.success) return parsed.data;
  throw new InvalidInput(
    `The output of ${tool} does not match its schema.\n${z.prettifyError(parsed.error)}`,
  );
}

type Submission =
  | { readonly kind: 'submitted'; readonly tool: string; readonly output: unknown }
  | { readonly kind: 'failed'; readonly errors: string };

export interface OrchestrationEffectsOptions {
  readonly store: Store;
  readonly execution: Execution;
  readonly vcs: Vcs;
  /** `undefined` while the daemon has no code host: a play cannot start without one. */
  readonly workspace: Workspace | undefined;
  readonly dispatcher: PromptDispatcher;
  readonly directors: DirectorSessions;
  readonly prompts: PromptSource;
  readonly registries: Registries;
  readonly config: DaemonConfig;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly logger: Logger;
  /**
   * Whether someone is watching the play now: a Producer chat polling its scenario
   * (`ChatPresence`). [proposta] With nobody, `delivery.base_drift: ask` is `update` (N83). Absent
   * means nobody. Not used for the `attended` of `delivery.mode: ask` (see `#deliver`).
   */
  readonly attended?: ((scope: PlayEffectScope) => boolean) | undefined;
}

/** How much of the diff of an earlier attempt goes into the prompt of the next one. */
const CARRIED_DIFF_CHARS = 20_000;

/** The demands a play wants running now, and when that was last asked. */
interface Wanted {
  readonly generation: number;
  /** Bumped by every `run_demands`: a demand that finishes after a newer ask is still wanted. */
  seq: number;
  ids: Set<string>;
  feedback: string | null;
  submitRetries: number;
}

/**
 * The effects of the play (architecture 5.4: "efeitos longos ficam fora da máquina e voltam como
 * eventos"). Each effect starts its work in the background and sends the result to the
 * {@link PlayRunner} as an event; `dispatch` itself returns as soon as the work has started.
 *
 * - **Idempotent.** The runner asks again for the effects of a state after a restart (P9), so a
 *   second `run_demands` finds the demands already running, a second `judge` finds the decision
 *   already pending, a second `integrate` or `deliver` is replayed by the Workspace's side-effect
 *   records.
 * - **Generations.** `abort_work` cannot stop an attempt in flight (the runner only stops them all,
 *   with the daemon): it bumps the generation of the play, and what the old work sends later is
 *   dropped. [proposta]
 * - **Failures become events.** An effect that cannot run (no Executor configured, a bad branch
 *   name, an exception) sends the failure event of its state (`SUBMIT_FAILED`, `ATTEMPT_FAILED`),
 *   so the counters of 5.4 decide what happens next, never a hung play.
 */
export class OrchestrationEffects implements PlayEffects {
  readonly #options: OrchestrationEffectsOptions;
  readonly #tasks = new Set<Promise<void>>();
  readonly #generations = new Map<string, number>();
  readonly #wanted = new Map<string, Wanted>();
  readonly #inflight = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #runner: PlayRunner | undefined;
  #closed = false;

  constructor(options: OrchestrationEffectsOptions) {
    this.#options = options;
  }

  /** The runner is built with these effects, so it is handed in afterwards. */
  bind(runner: PlayRunner): void {
    this.#runner = runner;
  }

  dispatch(effect: PlayEffect, scope: PlayEffectScope): Promise<void> {
    this.#dispatchNow(effect, scope);
    return Promise.resolve();
  }

  /** Starts the work of an effect; what takes time runs apart (`#spawn`), so this does not wait. */
  #dispatchNow(effect: PlayEffect, scope: PlayEffectScope): void {
    if (this.#closed) return;
    const generation = this.#generationOf(scope.playId);
    switch (effect.type) {
      case 'abort_work':
        this.#generations.set(scope.playId, generation + 1);
        this.#wanted.delete(scope.playId);
        return;
      case 'run_stage':
        this.#spawn(`run_stage ${effect.stage}`, scope, async () => {
          await this.#runStage(effect, scope, generation);
        });
        return;
      case 'run_demands':
        this.#spawn('run_demands', scope, async () => {
          await this.#wantDemands(effect, scope, generation);
        });
        return;
      case 'integrate':
        this.#spawn('integrate', scope, async () => {
          await this.#integrate(effect, scope, generation);
        });
        return;
      case 'deliver':
        this.#spawn('deliver', scope, async () => {
          await this.#deliver(effect, scope, generation);
        });
        return;
      case 'judge':
        this.#spawn('judge', scope, async () => {
          await this.#judge(effect, scope);
        });
        return;
      case 'ask_menu':
        this.#spawn('ask_menu', scope, async () => {
          await this.#askMenu(effect, scope);
        });
        return;
      case 'rebase_dependents':
        this.#spawn('rebase_dependents', scope, async () => {
          await this.#rebaseDependents(effect, scope, generation);
        });
        return;
      case 'verify_demand':
        // Judgment point 2 (partial work) is not reachable until the Director's answers for it
        // exist (P12); the effect is logged and not run.
        this.#options.logger.warn(
          { effect: effect.type, playId: scope.playId },
          'this effect has no implementation yet',
        );
        return;
    }
  }

  /** Resolves when the work started so far has ended. */
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  /** From now on nothing is sent to the runner and no effect starts. Idempotent. */
  close(): void {
    this.#closed = true;
    this.#wanted.clear();
  }

  // ---- plumbing ----

  #generationOf(playId: string): number {
    return this.#generations.get(playId) ?? 0;
  }

  #spawn(label: string, scope: PlayEffectScope, work: () => Promise<void>): void {
    const task: Promise<void> = work()
      .catch((error: unknown) => {
        if (this.#closed) return;
        this.#options.logger.error(
          { err: error, playId: scope.playId, effect: label },
          'a play effect failed',
        );
      })
      .finally(() => {
        this.#tasks.delete(task);
      });
    this.#tasks.add(task);
  }

  /** Runs `work` after the earlier work of the same key, one at a time. */
  async #locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  /** Sends an event of the play unless the play was aborted since `generation` or the daemon stops. */
  async #send(playId: string, generation: number | undefined, event: unknown): Promise<void> {
    if (this.#closed || this.#runner === undefined) return;
    if (generation !== undefined && generation !== this.#generationOf(playId)) return;
    try {
      await this.#runner.send(playId, event);
    } catch (error) {
      // A late result for a state the play already left: the machine refuses it, which is right.
      this.#options.logger.warn(
        { err: error, playId, event },
        'the machine did not take an event of an effect',
      );
    }
  }

  async #repoOf(
    scenarioId: string,
  ): Promise<{ path: string; mainBranch: string; remote?: string }> {
    const repos = await this.#options.store.scenarioRepos.list(scenarioId);
    const repo = repos[0];
    if (repo === undefined) {
      throw new NotFound(`The scenario "${scenarioId}" has no repository`);
    }
    return {
      path: repo.path,
      mainBranch: repo.mainBranch,
      ...(repo.remote === null ? {} : { remote: repo.remote }),
    };
  }

  async #needOf(playId: string): Promise<string> {
    const play = await this.#options.store.plays.get(playId);
    if (play === undefined) throw new NotFound(`There is no play "${playId}"`);
    return play.need;
  }

  async #limitsOf(playId: string): Promise<PlayLimits> {
    const play = await this.#options.store.plays.get(playId);
    if (play === undefined) throw new NotFound(`There is no play "${playId}"`);
    return restorePlay(play).context.limits;
  }

  async #blackboard(playId: string, key: string): Promise<unknown> {
    return (await this.#options.store.blackboard.get(playId, key))?.value;
  }

  async #planText(playId: string): Promise<string | undefined> {
    const value = await this.#blackboard(playId, PLAN_KEY);
    const parsed = planOutput.safeParse(value);
    return parsed.success ? parsed.data.plan : undefined;
  }

  async #script(playId: string): Promise<Script | undefined> {
    const value = await this.#blackboard(playId, SCRIPT_KEY);
    if (value === undefined) return undefined;
    const parsed = parseScript(value);
    return parsed.success ? parsed.script : undefined;
  }

  async #attemptsOf(playId: string, demandId: string): Promise<AttemptRecord[]> {
    const all = await this.#options.store.attempts.list();
    return all.filter((a) => a.playId === playId && a.demandId === demandId);
  }

  async #nextAttempt(playId: string, demandId: string): Promise<number> {
    const attempts = await this.#attemptsOf(playId, demandId);
    return attempts.reduce((max, a) => Math.max(max, a.attempt), 0) + 1;
  }

  /** The newest attempt of the demand that ran to its end. */
  async #latestCompleted(playId: string, demandId: string): Promise<AttemptRecord | undefined> {
    const attempts = await this.#attemptsOf(playId, demandId);
    return attempts.filter((a) => a.state === 'completed').sort((a, b) => b.attempt - a.attempt)[0];
  }

  /**
   * The prompt prefix of a role. [proposta] One spot: the orders in force (P10) and the project
   * rules go here when they exist.
   */
  async #prefix(role: string, contract?: string): Promise<string> {
    const { prompts, registries } = this.#options;
    return assemblePrefix({
      role,
      rolePrompt: await prompts.get(role),
      tools: registries.tools.list(),
      ...(contract === undefined ? {} : { contract }),
    });
  }

  /** What the submit tools of an attempt recorded after `mark`, if anything. */
  async #submissionOf(attemptId: string, mark: number): Promise<Submission | undefined> {
    const { events } = this.#options.store;
    let after = mark;
    let found: Submission | undefined;
    for (;;) {
      const page: readonly EventEnvelope[] = await events.readFrom(after, 500);
      if (page.length === 0) return found;
      for (const event of page) {
        after = event.id;
        const payload = event.payload as Record<string, unknown>;
        if (payload.attemptId !== attemptId) continue;
        if (event.type === 'attempt.submitted') {
          found = { kind: 'submitted', tool: String(payload.tool), output: payload.output };
        } else if (event.type === 'attempt.submit_failed') {
          found = { kind: 'failed', errors: String(payload.errors) };
        }
      }
    }
  }

  // ---- stages ----

  async #runStage(
    effect: Extract<PlayEffect, { type: 'run_stage' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { playId } = scope;
    if (effect.stage === 'CLARIFYING') {
      await this.#clarify(scope);
      return;
    }
    const fail = (reason: string): Promise<void> =>
      this.#send(playId, generation, { type: 'SUBMIT_FAILED', reason: clip(reason) });
    let submission: Submission | string | undefined;
    try {
      submission = await this.#runStageAttempt(effect, scope);
    } catch (error) {
      await fail(messageOf(error));
      return;
    }
    if (typeof submission === 'string') {
      await fail(submission);
      return;
    }
    if (submission === undefined) {
      await fail(`The ${effect.role} ended its turn without calling its submit tool.`);
      return;
    }
    if (submission.kind === 'failed') {
      await fail(submission.errors);
      return;
    }
    await this.#stageResult(effect, scope, generation, submission.output).catch(
      async (error: unknown) => {
        await fail(messageOf(error));
      },
    );
  }

  /** The tool policy of a role for the scenario of the play (`roles.<role>.policy`, P1). */
  #policyOf(role: string, scenarioId: string): Promise<RolePolicy> {
    const { config, store, registries } = this.#options;
    return resolveRolePolicy(
      { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
      role,
      scenarioId,
    );
  }

  /**
   * Runs the session of the role over a worktree of the play and reads what it submitted. A
   * string is the reason the attempt cannot count (it did not end well).
   */
  async #runStageAttempt(
    effect: Extract<PlayEffect, { type: 'run_stage' }>,
    scope: PlayEffectScope,
  ): Promise<Submission | string | undefined> {
    const { store, execution, config, paths, vcs } = this.#options;
    const { playId, scenarioId } = scope;
    const policy = await this.#policyOf(effect.role, scenarioId);
    const executor = executorOf(config, effect.role);
    if (executor === undefined) {
      throw new AdapterUnavailable(
        `No Executor is configured for the ${effect.role}: set orchestration.executor.`,
      );
    }
    const repo = await this.#repoOf(scenarioId);
    const need = await this.#needOf(playId);
    const plan = await this.#planText(playId);
    const scriptValue = await this.#blackboard(playId, SCRIPT_KEY);
    // A script that is being rewritten shows the one it replaces, so the Scriptwriter can mark
    // the demands it keeps (N84); `redo_all` redoes everything and has nothing to mark.
    const previousScript =
      effect.stage === 'SCRIPTING' &&
      scriptValue !== undefined &&
      config.rescript.reuse !== 'redo_all'
        ? JSON.stringify(scriptValue, null, 2)
        : undefined;
    const demandId = stageDemandId(effect.stage);
    const attempt = await this.#nextAttempt(playId, demandId);
    const base = effect.stage === 'CRITIQUING' ? integrationBranch(playId) : playBranch(playId);
    const body = stagePrompt({
      stage: effect.stage,
      role: effect.role,
      playId,
      need,
      feedback: effect.feedback,
      restart: effect.restart,
      plan: effect.stage === 'PLANNING' ? undefined : plan,
      script:
        scriptValue === undefined || effect.stage === 'PLANNING' || effect.stage === 'SCRIPTING'
          ? undefined
          : JSON.stringify(scriptValue, null, 2),
      attempt,
      baseRef: base,
      previousScript,
    });
    const prompt = `${await this.#prefix(effect.role)}\n${body}`;
    const { profile, executor: settings } = sessionSettingsOf(paths, executor);
    const mark = await store.events.lastId();
    const outcome = await execution.runner.run({
      playId,
      demandId,
      attempt,
      repo: repo.path,
      base,
      profile,
      executor: settings,
      policy,
      prompt,
      role: effect.role,
    });
    // The worktree of a stage is a scratch place; the branch (and its history) stays.
    await vcs.removeWorktree(outcome.worktree, { force: true }).catch(() => undefined);
    if (outcome.state !== 'completed') {
      return `The ${effect.role} session ${outcome.state}${outcome.cause === undefined ? '' : `: ${outcome.cause}`}.`;
    }
    return this.#submissionOf(outcome.attemptId, mark);
  }

  /** What the output of a stage means for the play: blackboard, rows and the event it sends. */
  async #stageResult(
    effect: Extract<PlayEffect, { type: 'run_stage' }>,
    scope: PlayEffectScope,
    generation: number,
    output: unknown,
  ): Promise<void> {
    const { store } = this.#options;
    const { playId } = scope;
    switch (effect.stage) {
      case 'PLANNING': {
        const plan = readStageOutput(planOutput, 'submit_plan', output);
        await store.blackboard.put({
          playId,
          key: PLAN_KEY,
          value: asJson(plan),
          author: effect.role,
        });
        await this.#send(playId, generation, {
          type: 'PLAN_SUBMITTED',
          hasOpenQuestions: plan.openQuestions.length > 0,
        });
        return;
      }
      case 'REVIEWING_PLAN': {
        const review = readStageOutput(reviewOutput, 'submit_plan_review', output);
        await this.#send(playId, generation, {
          type: 'PLAN_REVIEWED',
          approved: review.approved,
          ...(review.reason === undefined ? {} : { reason: clip(review.reason) }),
        });
        return;
      }
      case 'SCRIPTING':
        await this.#scriptResult(
          scope,
          generation,
          readStageOutput(scriptOutput, 'submit_script', output).script,
        );
        return;
      case 'REVIEWING_SCRIPT': {
        const review = readStageOutput(reviewOutput, 'submit_script_review', output);
        await this.#send(playId, generation, {
          type: 'SCRIPT_REVIEWED',
          approved: review.approved,
          ...(review.reason === undefined ? {} : { reason: clip(review.reason) }),
        });
        return;
      }
      case 'CRITIQUING': {
        const review = readStageOutput(reviewOutput, 'submit_critique', output);
        await this.#send(playId, generation, {
          type: 'CRITIQUED',
          approved: review.approved,
          ...(review.reason === undefined ? {} : { reason: clip(review.reason) }),
        });
        return;
      }
      default:
        throw new InvalidInput(`The stage ${effect.stage} takes no submission`);
    }
  }

  /** The validation in code of the script (5.4, "validação em código"); then the rows of the demands. */
  async #scriptResult(
    scope: PlayEffectScope,
    generation: number,
    submitted: unknown,
  ): Promise<void> {
    const { store } = this.#options;
    const { playId } = scope;
    const limits = await this.#limitsOf(playId);
    const parsed = parseScript(submitted);
    const issues = parsed.success
      ? validateScript(parsed.script, {
          demandTimeoutMaxMin: Math.floor(limits.demand_timeout_max / 60_000),
        })
      : parsed.issues;
    if (!parsed.success || issues.length > 0) {
      await this.#send(playId, generation, {
        type: 'SCRIPT_VALIDATED',
        valid: false,
        reason: clip(issues.map((issue) => issue.message).join('\n')),
      });
      return;
    }
    const { script } = parsed;
    const previous = await this.#script(playId);
    const kept = await this.#keptBy(playId, previous, script);
    await store.blackboard.put({
      playId,
      key: SCRIPT_KEY,
      value: asJson(script),
      author: 'scriptwriter',
    });
    for (const contract of script.contracts) {
      await store.blackboard.put({
        playId,
        key: contractKey(contract.id),
        value: asJson(contract),
        author: 'scriptwriter',
      });
    }
    const timeoutMin = Math.max(1, Math.ceil(limits.demand_timeout / 60_000));
    for (const demand of script.demands) {
      const existing = await store.demands.get(playId, demand.id);
      if (existing === undefined) {
        await store.demands.create({
          playId,
          id: demand.id,
          title: demand.title,
          description: demand.description,
          dependsOn: [...demand.dependsOn],
          contract: { inputs: [...demand.contract.inputs], outputs: [...demand.contract.outputs] },
          expectedFiles: [...demand.expectedFiles],
          complexity: demand.complexity,
          specialty: demand.specialty ?? null,
          timeoutMin: demand.timeoutMin ?? timeoutMin,
          acceptanceCriteria: [...demand.acceptanceCriteria],
          verify: demand.verify.map((step) => ({ ...step, args: [...step.args] })),
          verifyWaiver: demand.verifyWaiver ?? null,
          state: 'pending',
        });
      } else if (existing.state !== 'pending' && !kept.includes(demand.id)) {
        // A new script starts every demand over, except the ones it kept (N84): the work of the
        // old script is not trusted.
        await store.demands.update(playId, demand.id, { state: 'pending' });
      }
    }
    await this.#carryForward(playId, previous, script, kept);
    await this.#rebuildIntegration(scope);
    await this.#send(playId, generation, {
      type: 'SCRIPT_VALIDATED',
      valid: true,
      demandIds: script.demands.map((demand) => demand.id),
      ...(kept.length === 0 ? {} : { keptDemandIds: kept }),
    });
  }

  /**
   * The demands of the new script that keep their approved work (N84): marked `unchanged`,
   * equal to the old ones (`keptDemands`) and still done: approved in the play, in its row, and
   * with a finished attempt to integrate.
   */
  async #keptBy(playId: string, previous: Script | undefined, next: Script): Promise<string[]> {
    const { store, config } = this.#options;
    const mode = config.rescript.reuse;
    if (mode === 'redo_all' || previous === undefined) return [];
    const play = await store.plays.get(playId);
    const inPlay = new Set(play === undefined ? [] : restorePlay(play).context.approvedDemands);
    const done = new Set<string>();
    for (const demand of next.demands) {
      if (!inPlay.has(demand.id)) continue;
      const row = await store.demands.get(playId, demand.id);
      if (
        row?.state === 'approved' &&
        (await this.#latestCompleted(playId, demand.id)) !== undefined
      ) {
        done.add(demand.id);
      }
    }
    return keptDemands({ mode, previous, next, approved: done });
  }

  /**
   * What a changed demand takes from its earlier attempt (N84): a `carry` note (the diff for
   * `keep_unchanged`, the branch to start from for `from_previous`). `redo_all` carries nothing.
   */
  async #carryForward(
    playId: string,
    previous: Script | undefined,
    next: Script,
    kept: readonly string[],
  ): Promise<void> {
    const { store, config } = this.#options;
    const mode = config.rescript.reuse;
    for (const demand of next.demands) {
      if (kept.includes(demand.id)) continue;
      const key = carryKey(demand.id);
      const latest = await this.#latestCompleted(playId, demand.id);
      const old = previous?.demands.find((candidate) => candidate.id === demand.id);
      if (
        mode === 'redo_all' ||
        previous === undefined ||
        old === undefined ||
        latest === undefined
      ) {
        // a note of an earlier conflict must not outlive the script that replaced its demand
        if ((await this.#blackboard(playId, key)) !== undefined) {
          await store.blackboard.put({ playId, key, value: null, author: 'daemon' });
        }
        continue;
      }
      const carry: Carry = {
        fromAttempt: latest.attempt,
        kind: 'rescript',
        branch: latest.branch,
        oldBase: await this.#oldBaseOf(playId, old, latest),
        resolve: false,
        startFromBranch: mode === 'from_previous',
        mergeIn: null,
        files: [],
      };
      await store.blackboard.put({ playId, key, value: asJson(carry), author: 'daemon' });
    }
  }

  /**
   * The branch an attempt started on: the newest finished attempt of its first dependency that
   * existed when it began, else the base of the play. [proposta] The attempt records have no base.
   */
  async #oldBaseOf(playId: string, demand: Demand, attempt: AttemptRecord): Promise<string> {
    const first = demand.dependsOn[0];
    if (first === undefined) return playBranch(playId);
    const before = (await this.#attemptsOf(playId, first))
      .filter((other) => other.state === 'completed' && other.createdAt <= attempt.createdAt)
      .sort((a, b) => b.attempt - a.attempt)[0];
    return before?.branch ?? playBranch(playId);
  }

  /** The number of the current build of the integration branch (1 until a script rebuilds it). */
  async #roundOf(playId: string): Promise<number> {
    const value = await this.#blackboard(playId, INTEGRATION_ROUND_KEY);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
  }

  /**
   * A new script drops the integration branch, so it is built again from the base with the
   * demands of the new script (N84, "a integração é refeita"). The round goes up first: a crash
   * between the two steps leaves a branch that the new round merges over, never a branch that the
   * registry thinks is built.
   */
  async #rebuildIntegration(scope: PlayEffectScope): Promise<void> {
    const { workspace, vcs, store } = this.#options;
    if (workspace === undefined || !supportsHistory(vcs)) return;
    const { playId, scenarioId } = scope;
    const repo = await this.#repoOf(scenarioId);
    try {
      await vcs.resolveRef(repo.path, integrationBranch(playId));
    } catch (error) {
      if (hasErrorCode(error, 'NOT_FOUND')) return;
      throw error;
    }
    await store.blackboard.put({
      playId,
      key: INTEGRATION_ROUND_KEY,
      value: (await this.#roundOf(playId)) + 1,
      author: 'daemon',
    });
    await workspace.resetIntegration({ repo: repo.path, playId });
  }

  /** CLARIFYING: the Director asks the Producer what the plan left open, and answers `clarify`. */
  async #clarify(scope: PlayEffectScope): Promise<void> {
    const { store, dispatcher, directors } = this.#options;
    const { playId, scenarioId } = scope;
    const created = await this.#locked(playId, async () => {
      const pending = await store.decisions.list({
        playId,
        kinds: [DECISION_KINDS.clarify],
        states: ['pending'],
      });
      if (pending.length > 0) return false;
      const all = await store.decisions.list({ playId, kinds: [DECISION_KINDS.clarify] });
      const value = await this.#blackboard(playId, PLAN_KEY);
      const plan = planOutput.safeParse(value);
      await store.decisions.create({
        id: `${playId}:clarify:${String(all.length + 1)}`,
        scenarioId,
        playId,
        kind: DECISION_KINDS.clarify,
        input: {
          playId,
          plan: plan.success ? plan.data.plan : '',
          questions: plan.success ? plan.data.openQuestions : [],
        },
      });
      return true;
    });
    if (!created) return;
    await directors.ensure(scenarioId);
    await dispatcher.submit({ scenarioId, source: 'daemon', text: clarifyPrompt(playId) });
  }

  // ---- demands ----

  async #wantDemands(
    effect: Extract<PlayEffect, { type: 'run_demands' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { playId } = scope;
    let wanted = this.#wanted.get(playId);
    if (wanted?.generation !== generation) {
      wanted = {
        generation,
        seq: 0,
        ids: new Set(),
        feedback: null,
        submitRetries: effect.submitRetries,
      };
      this.#wanted.set(playId, wanted);
    }
    // A demand that is asked again with an approved row (a dependent that is redone) starts over:
    // its stale row would let the demands that wait for it start too early.
    for (const id of effect.demandIds) {
      const row = await this.#options.store.demands.get(playId, id);
      if (row?.state === 'approved') {
        await this.#options.store.demands.update(playId, id, { state: 'pending' });
      }
    }
    wanted.seq += 1;
    wanted.ids = new Set(effect.demandIds);
    wanted.feedback = effect.feedback;
    wanted.submitRetries = effect.submitRetries;
    await this.#schedule(scope, generation);
  }

  /** Starts every wanted demand that is not running and whose dependencies are approved. */
  async #schedule(scope: PlayEffectScope, generation: number): Promise<void> {
    const { store } = this.#options;
    const { playId } = scope;
    await this.#locked(`schedule:${playId}`, async () => {
      const wanted = this.#wanted.get(playId);
      if (this.#closed || wanted?.generation !== generation) return;
      const script = await this.#script(playId);
      if (script === undefined) return;
      for (const id of [...wanted.ids]) {
        const key = `${playId}/${id}/${String(generation)}`;
        if (this.#inflight.has(key)) continue;
        const demand = script.demands.find((candidate) => candidate.id === id);
        if (demand === undefined) continue;
        let ready = true;
        for (const dependency of demand.dependsOn) {
          const row = await store.demands.get(playId, dependency);
          if (row?.state !== 'approved') ready = false;
        }
        if (!ready) continue;
        this.#inflight.add(key);
        const seq = wanted.seq;
        this.#spawn(`demand ${id}`, scope, async () => {
          try {
            await this.#runDemand(demand, scope, generation, wanted);
          } finally {
            this.#inflight.delete(key);
            // asked again while it ran (a retry): stays wanted
            if (wanted.seq === seq) wanted.ids.delete(id);
            await this.#schedule(scope, generation);
          }
        });
      }
    });
  }

  async #runDemand(
    demand: Demand,
    scope: PlayEffectScope,
    generation: number,
    wanted: Wanted,
  ): Promise<void> {
    const { store, execution, config, paths, vcs } = this.#options;
    const { playId, scenarioId } = scope;
    const limits = await this.#limitsOf(playId);
    const timeoutMin = demand.timeoutMin ?? Math.max(1, Math.ceil(limits.demand_timeout / 60_000));
    const attempt = await this.#nextAttempt(playId, demand.id);
    const failed = (reason: string): Promise<void> =>
      this.#send(playId, generation, {
        type: 'ATTEMPT_FAILED',
        demandId: demand.id,
        reason: clip(reason),
      });
    await this.#send(playId, generation, {
      type: 'DEMAND_STARTED',
      demandId: demand.id,
      timeoutMin,
    });
    await store.demands.update(playId, demand.id, { state: 'running' });
    try {
      // The id must name a branch (the runner asserts it): a script with an id it cannot take
      // fails the attempt with a reason the Author can act on, not the whole play.
      attemptBranch(playId, demand.id, attempt);
    } catch (error) {
      await store.demands.update(playId, demand.id, { state: 'failed' });
      await failed(
        `The demand id "${demand.id}" cannot name a branch (use lowercase letters, digits and "-"): ${messageOf(error)}`,
      );
      return;
    }
    try {
      const executor = executorOf(config, 'actor');
      if (executor === undefined) {
        throw new AdapterUnavailable(
          'No Executor is configured for the actor: set orchestration.executor.',
        );
      }
      const repo = await this.#repoOf(scenarioId);
      const need = await this.#needOf(playId);
      const plan = await this.#planText(playId);
      // [proposta] A demand with one dependency starts from that dependency's work; with several,
      // from the first one (the merge of all of them is the integration, not the start of a
      // demand); with none, from the base of the play.
      const first = demand.dependsOn[0];
      const dependency =
        first === undefined ? undefined : await this.#latestCompleted(playId, first);
      const carried = await this.#carriedOf(playId, demand.id, repo.path);
      const base = carried?.startFrom ?? dependency?.branch ?? playBranch(playId);
      const body = stagePrompt({
        stage: 'EXECUTING',
        role: 'actor',
        playId,
        need,
        feedback: attempt > 1 ? wanted.feedback : null,
        restart: false,
        plan,
        demand,
        attempt,
        baseRef: base,
        carried: carried?.work,
      });
      const contract = [
        `Inputs: ${demand.contract.inputs.join(', ') || 'none'}`,
        `Outputs: ${demand.contract.outputs.join(', ')}`,
      ].join('\n');
      const prompt = `${await this.#prefix('actor', contract)}\n${body}`;
      const { profile, executor: settings } = sessionSettingsOf(paths, executor);
      const mark = await store.events.lastId();
      const outcome = await execution.runner.run({
        playId,
        demandId: demand.id,
        attempt,
        repo: repo.path,
        base,
        profile,
        executor: settings,
        policy: await this.#policyOf('actor', scenarioId),
        prompt,
        role: 'actor',
        timeoutMs: timeoutMin * 60_000,
      });
      if (outcome.state === 'interrupted') {
        // The daemon is stopping, or the attempt waits for a decision: reconciliation (P9) and the
        // Director's judgment points own what happens next, so nothing is sent.
        return;
      }
      if (outcome.state === 'timed_out') {
        await store.demands.update(playId, demand.id, { state: 'failed' });
        await this.#send(playId, generation, { type: 'ACTOR_TIMED_OUT', demandId: demand.id });
        return;
      }
      if (outcome.state === 'failed') {
        await store.demands.update(playId, demand.id, { state: 'failed' });
        await failed(
          `The attempt failed${outcome.cause === undefined ? '' : `: ${outcome.cause}`}.`,
        );
        return;
      }
      // A finished attempt takes no last checkpoint: what the Executor wrote is committed now.
      await vcs.commitAll(outcome.worktree, `Work of ${demand.id} (attempt ${String(attempt)})`);
      const submission = await this.#submissionOf(outcome.attemptId, mark);
      if (submission === undefined || submission.kind === 'failed') {
        await store.demands.update(playId, demand.id, { state: 'failed' });
        await failed(
          submission === undefined
            ? 'The Actor ended its turn without calling `submit`.'
            : submission.errors,
        );
        return;
      }
      const problem = await this.#verify(demand, outcome.worktree, timeoutMin * 60_000);
      if (problem !== undefined) {
        await store.demands.update(playId, demand.id, { state: 'failed' });
        await failed(problem);
        return;
      }
      await store.demands.update(playId, demand.id, { state: 'approved' });
      // A demand that was redone while others already depend on its old work opens judgment
      // point 8 first; its approval follows the answer (the play must not integrate stale work).
      const dependents = await this.#approvedDependents(playId, demand.id);
      if (dependents.length > 0) {
        await this.#send(playId, generation, {
          type: 'DEPENDENCY_REDONE',
          demandId: demand.id,
          dependentIds: dependents,
          verified: true,
        });
        return;
      }
      await this.#send(playId, generation, { type: 'DEMAND_APPROVED', demandId: demand.id });
    } catch (error) {
      await store.demands.update(playId, demand.id, { state: 'failed' }).catch(() => undefined);
      await failed(messageOf(error));
    }
  }

  /**
   * The earlier attempt this demand takes over (N82, N84), from its `carry` note: what the prompt
   * says, and the branch the new attempt starts on when it is not the usual base. The note holds
   * while the newest finished attempt is the one it was written for.
   */
  async #carriedOf(
    playId: string,
    demandId: string,
    repo: string,
  ): Promise<{ work: CarriedWork; startFrom: string | undefined } | undefined> {
    const parsed = CarrySchema.safeParse(await this.#blackboard(playId, carryKey(demandId)));
    if (!parsed.success) return undefined;
    const carry = parsed.data;
    const latest = await this.#latestCompleted(playId, demandId);
    if (latest?.attempt !== carry.fromAttempt) return undefined;
    let diff: { text: string; truncated: boolean } | undefined;
    // With the earlier branch as the start, its work is in the worktree: no diff to show.
    if (!carry.startFromBranch && supportsDiff(this.#options.vcs)) {
      diff = await this.#options.vcs
        .diffBetween(repo, carry.oldBase ?? playBranch(playId), carry.branch, CARRIED_DIFF_CHARS)
        .catch((error: unknown) => {
          this.#options.logger.warn({ err: error, playId, demandId }, 'cannot read the old diff');
          return undefined;
        });
    }
    return {
      startFrom: carry.startFromBranch ? carry.branch : undefined,
      work: {
        kind: carry.kind,
        branch: carry.branch,
        diff: diff?.text,
        truncated: diff?.truncated,
        resolve: carry.resolve,
        mergeIn: carry.mergeIn,
        files: carry.files,
        startsFromBranch: carry.startFromBranch,
      },
    };
  }

  /**
   * The verify steps of the demand (5.4, "verify em código"): each runs in the worktree and must
   * exit 0. `undefined` when all passed (or the demand has a waiver, or `orchestration.verify` is
   * `skip`). [proposta] The steps run as the daemon's user, with no sandbox: they come from a
   * script a reviewer approved, but the sandbox of the commands is a decision for later.
   */
  async #verify(demand: Demand, worktree: string, timeoutMs: number): Promise<string | undefined> {
    if (this.#options.config.orchestration.verify === 'skip') return undefined;
    if (demand.verifyWaiver !== undefined) return undefined;
    for (const step of demand.verify) {
      try {
        await execFileAsync(step.command, [...step.args], {
          cwd: worktree,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        const { stderr, stdout } = error as { stderr?: string; stdout?: string };
        const tail = (stderr ?? '').trim() || (stdout ?? '').trim() || messageOf(error);
        return `The verify step "${step.name}" (${step.command} ${step.args.join(' ')}) failed: ${tail.slice(-800)}`;
      }
    }
    return undefined;
  }

  /**
   * Judgment point 8, "rebase": the finished work of the dependents of a redone demand moves onto
   * its new branch (N82), the dependents in the order of the script. A dependent that does not
   * conflict is simply moved (and is not verified again: [proposta]). One that conflicts keeps
   * its branch as it was, gets a `carry` note, and `integration.rebase_conflict` says what
   * happens: `redo` and `resolve_attempt` open a new attempt, `script_failure` returns to the
   * script. The machine counts it.
   */
  async #rebaseDependents(
    effect: Extract<PlayEffect, { type: 'rebase_dependents' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { store } = this.#options;
    const { playId } = scope;
    try {
      await this.#moveDependents(effect, scope, generation);
    } finally {
      // The redone demand waited for the dependents (`DEPENDENCY_REDONE`, `verified`): now it is
      // approved, a conflict or not (the machine already took the conflict, if there was one).
      const play = await store.plays.get(playId);
      const row = await store.demands.get(playId, effect.demandId);
      const context = play === undefined ? undefined : restorePlay(play).context;
      const waiting =
        play?.state === 'EXECUTING' &&
        context !== undefined &&
        context.demandIds.includes(effect.demandId) &&
        !context.approvedDemands.includes(effect.demandId) &&
        context.openJudgments.every((j) => j.demandId !== effect.demandId);
      if (waiting && row?.state === 'approved') {
        await this.#send(playId, generation, {
          type: 'DEMAND_APPROVED',
          demandId: effect.demandId,
        });
      }
    }
  }

  /**
   * The demands that depend, directly or not, on `demandId` and that the play holds as approved,
   * in the order of the script ([proposta]: judgment point 8 carries them all).
   */
  async #approvedDependents(playId: string, demandId: string): Promise<string[]> {
    const play = await this.#options.store.plays.get(playId);
    const script = await this.#script(playId);
    if (play === undefined || script === undefined) return [];
    const approved = new Set(restorePlay(play).context.approvedDemands);
    const reach = new Set([demandId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const demand of script.demands) {
        if (!reach.has(demand.id) && demand.dependsOn.some((id) => reach.has(id))) {
          reach.add(demand.id);
          grew = true;
        }
      }
    }
    return topologicalLayers(script)
      .flat()
      .filter((id) => id !== demandId && reach.has(id) && approved.has(id));
  }

  async #moveDependents(
    effect: Extract<PlayEffect, { type: 'rebase_dependents' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { vcs, config, logger, store } = this.#options;
    const { playId, scenarioId } = scope;
    if (!supportsRebase(vcs) || !supportsHistory(vcs)) {
      logger.warn({ playId, adapter: vcs.id }, 'the Vcs adapter cannot rebase; nothing was moved');
      return;
    }
    const script = await this.#script(playId);
    if (script === undefined) return;
    const repo = await this.#repoOf(scenarioId);
    const mode = config.integration.rebase_conflict;
    const oldTips = new Map<string, string>();
    const conflicted = new Set<string>();
    const order = topologicalLayers(script)
      .flat()
      .filter((id) => effect.dependentIds.includes(id));
    for (const id of order) {
      const demand = script.demands.find((candidate) => candidate.id === id);
      const first = demand?.dependsOn[0];
      // only a demand that started from the branch of the redone one moves with it
      if (demand === undefined || first === undefined || conflicted.has(first)) continue;
      if (first !== effect.demandId && !oldTips.has(first)) continue;
      const target = await this.#latestCompleted(playId, first);
      const own = await this.#latestCompleted(playId, id);
      if (target === undefined || own === undefined) continue;
      const upstream = oldTips.get(first) ?? (await this.#oldBaseOf(playId, demand, own));
      // a finished attempt stays checked out; a branch cannot move while it is
      for (const entry of await vcs.listWorktrees(repo.path)) {
        if (entry.branch === own.branch) await vcs.removeWorktree(entry.path, { force: true });
      }
      oldTips.set(id, await vcs.resolveRef(repo.path, own.branch));
      let files: string[] = [];
      let why: string;
      try {
        const outcome = await vcs.rebaseBranch(repo.path, own.branch, target.branch, { upstream });
        if (outcome.kind !== 'conflict') continue;
        files = [...outcome.files];
        why = `conflicts in: ${files.join(', ')}`;
      } catch (error) {
        // not a conflict but the same remedy: the work of the demand cannot ride on the new base
        why = `could not be moved: ${messageOf(error)}`;
      }
      conflicted.add(id);
      const resolve = mode === 'resolve_attempt';
      const carry: Carry = {
        fromAttempt: own.attempt,
        kind: 'rebase_conflict',
        branch: own.branch,
        oldBase: upstream,
        resolve,
        startFromBranch: resolve,
        mergeIn: resolve ? target.branch : null,
        files,
      };
      await store.blackboard.put({
        playId,
        key: carryKey(id),
        value: asJson(carry),
        author: 'daemon',
      });
      await this.#send(playId, generation, {
        type: 'REBASE_CONFLICT',
        demandId: id,
        mode,
        files,
        reason: clip(
          `The finished work of "${id}" (attempt ${String(own.attempt)}) moved onto the new work of "${first}" ${why}.`,
        ),
      });
    }
  }

  // ---- integration and delivery ----

  async #integrate(
    effect: Extract<PlayEffect, { type: 'integrate' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { workspace } = this.#options;
    const { playId, scenarioId } = scope;
    const fail = (reason: string): Promise<void> =>
      this.#send(playId, generation, { type: 'INTEGRATED', ok: false, reason: clip(reason) });
    try {
      if (workspace === undefined) throw new AdapterUnavailable('The daemon has no code host');
      const script = await this.#script(playId);
      if (script === undefined) throw new NotFound(`The play ${playId} has no script`);
      const repo = await this.#repoOf(scenarioId);
      const approved: { demandId: string; attempt: number }[] = [];
      for (const demandId of effect.demandIds) {
        const latest = await this.#latestCompleted(playId, demandId);
        if (latest === undefined)
          throw new NotFound(`The demand "${demandId}" has no finished attempt`);
        approved.push({ demandId, attempt: latest.attempt });
      }
      const result = await workspace.integrate({
        repo: repo.path,
        playId,
        script,
        approved,
        round: await this.#roundOf(playId),
      });
      if (result.kind === 'integrated') {
        await this.#send(playId, generation, { type: 'INTEGRATED', ok: true });
      } else if (result.kind === 'script_failure') {
        await fail(
          `Merging the demand "${result.demandId}" (attempt ${String(result.attempt)}) conflicts in: ${result.conflictFiles.join(', ')}.`,
        );
      } else {
        await fail(result.reason);
      }
    } catch (error) {
      await fail(messageOf(error));
    }
  }

  async #deliver(
    effect: Extract<PlayEffect, { type: 'deliver' }>,
    scope: PlayEffectScope,
    generation: number,
  ): Promise<void> {
    const { workspace, config, logger } = this.#options;
    const { playId, scenarioId } = scope;
    if (workspace === undefined) {
      logger.error({ playId }, 'the delivery needs a code host and the daemon has none');
      return;
    }
    const repo = await this.#repoOf(scenarioId);
    const warnings: string[] = [];
    if (effect.driftAccepted) {
      warnings.push(
        'The base moved while the play ran, and the Producer chose to deliver it with the conflicts.',
      );
    } else {
      const drift = await this.#updateToBase(effect, repo, playId);
      if (drift !== undefined) {
        const mode = config.delivery.base_drift;
        if (mode !== 'deliver_and_warn') {
          // `ask` needs someone to ask: with nobody it is `update` (N83)
          const asking = mode === 'ask' && this.#options.attended?.(scope) === true;
          await this.#send(playId, generation, {
            type: 'BASE_DRIFT',
            mode: asking ? 'ask' : 'update',
            files: drift.files,
            reason: clip(drift.reason),
          });
          return;
        }
        warnings.push(drift.reason);
        logger.warn({ playId, files: drift.files }, 'delivering although the base moved');
      }
    }
    const need = await this.#needOf(playId);
    const scenario = await this.#options.store.scenarios.get(scenarioId);
    const conventions = parseConventions(scenario?.conventions);
    const script = await this.#script(playId);
    const demands = effect.demandIds.flatMap((id) => {
      const demand = script?.demands.find((candidate) => candidate.id === id);
      return demand === undefined ? [] : [{ id, title: demand.title }];
    });
    // The title, the text of the PR, the merge commit and the changelog entry are built from the
    // store only (P7): the need, the demands, the state of the play. No model writes them.
    const artifacts = buildDeliveryArtifacts(
      {
        playId,
        need,
        demands,
        partial: effect.partial,
        criticWaived: effect.criticWaived,
      },
      conventions,
    );
    const changelogMode = changelogModeOf(config.delivery.changelog, scenario?.configOverride);
    const result = await workspace.deliver({
      repo: repo.path,
      playId,
      base: repo.mainBranch,
      ...(repo.remote === undefined ? {} : { remote: repo.remote }),
      title: artifacts.title,
      body: artifacts.body,
      mergeMessage: artifacts.mergeMessage,
      round: await this.#roundOf(playId),
      prepare: async (worktree) => {
        const change = await planChangelog({
          mode: changelogMode,
          worktree,
          entry: artifacts.entry,
          conventions,
        });
        return change === undefined
          ? undefined
          : { file: change.file, content: change.content, message: artifacts.changelogMessage };
      },
      configMode: config.delivery.mode,
      allowDirectMerge: config.delivery.allow_direct_merge,
      ...(warnings.length === 0 ? {} : { warnings }),
      // [proposta] Not the presence of the chat: `delivery.mode: ask` would answer `ask_producer`,
      // and no menu of the machine takes that answer yet (it is a decision of the owner, so the
      // play would hang in DELIVERING). The play is not attended here and `ask` falls to a PR.
      attended: false,
    });
    if (result.kind === 'delivered') {
      await this.#send(playId, generation, { type: 'DELIVERED' });
      return;
    }
    logger.error(
      { playId, result },
      'the delivery did not finish; the play stays in DELIVERING until it is resumed',
    );
  }

  /**
   * N83, `update`: the project's base may have moved while the play ran. `play/<id>/base` moves
   * onto it (the local ref, with no fetch: [proposta]) and is merged into the integration
   * branch; when something merged, the `verify` steps of the demands run again on the result.
   * `undefined` when the work is ready to deliver; else the conflicting files (or the `verify`
   * that failed, no files) and why. Safe to repeat: the merge is a side effect keyed by the base.
   */
  async #updateToBase(
    effect: Extract<PlayEffect, { type: 'deliver' }>,
    repo: { path: string; mainBranch: string },
    playId: string,
  ): Promise<{ files: string[]; reason: string } | undefined> {
    const { workspace } = this.#options;
    if (workspace === undefined) return undefined;
    await workspace.moveBase({ repo: repo.path, playId, onto: repo.mainBranch });
    const merged = await workspace.mergeBase({
      repo: repo.path,
      playId,
      round: await this.#roundOf(playId),
    });
    if (merged.kind === 'ambiguous') throw new Conflict(merged.reason);
    if (merged.kind === 'conflict') {
      const files = [...merged.conflictFiles];
      return {
        files,
        reason: `The base (${repo.mainBranch}) moved while the play ran and conflicts with the work in: ${files.join(', ')}.`,
      };
    }
    if (merged.kind === 'up_to_date') return undefined;
    const script = await this.#script(playId);
    const limits = await this.#limitsOf(playId);
    const ran = new Set<string>();
    for (const demand of script?.demands ?? []) {
      if (!effect.demandIds.includes(demand.id)) continue;
      const steps = JSON.stringify(demand.verify);
      if (ran.has(steps)) continue;
      ran.add(steps);
      const problem = await this.#verify(demand, merged.worktree, limits.demand_timeout);
      if (problem !== undefined) {
        return {
          files: [],
          reason: `The base (${repo.mainBranch}) moved while the play ran; after updating to it, ${problem}`,
        };
      }
    }
    return undefined;
  }

  // ---- decisions ----

  /** A judgment point: a pending decision row, and a notice to the Director through the queue. */
  async #judge(
    effect: Extract<PlayEffect, { type: 'judge' }>,
    scope: PlayEffectScope,
  ): Promise<void> {
    const { store, dispatcher, directors } = this.#options;
    const { playId, scenarioId } = scope;
    const kind = `${DECISION_KINDS.judgePrefix}${effect.point}`;
    const created = await this.#locked(playId, async () => {
      const mine = (await store.decisions.list({ playId, kinds: [kind] })).filter(
        (row) => row.input.demandId === (effect.demandId ?? null),
      );
      if (mine.some((row) => row.state === 'pending')) return false;
      const play = await store.plays.get(playId);
      const context = play === undefined ? undefined : restorePlay(play).context;
      await store.decisions.create({
        id: `${playId}:j:${effect.point}:${effect.demandId ?? '-'}:${String(mine.length + 1)}`,
        scenarioId,
        playId,
        kind,
        input: {
          playId,
          point: effect.point,
          demandId: effect.demandId,
          dependentIds: [...effect.dependentIds],
          reason: context?.feedback ?? null,
          demandIds: [...(context?.demandIds ?? [])],
          approvedDemands: [...(context?.approvedDemands ?? [])],
        },
      });
      return true;
    });
    if (!created) return;
    await directors.ensure(scenarioId);
    await dispatcher.submit({
      scenarioId,
      source: 'daemon',
      text: judgePrompt(playId, effect.point),
    });
  }

  /** AWAITING_PRODUCER: the menu is a pending decision the Producer answers (5.4). */
  async #askMenu(
    effect: Extract<PlayEffect, { type: 'ask_menu' }>,
    scope: PlayEffectScope,
  ): Promise<void> {
    const { store } = this.#options;
    const { playId, scenarioId } = scope;
    await this.#locked(playId, async () => {
      const all = await store.decisions.list({ playId, kinds: [DECISION_KINDS.menu] });
      if (all.some((row: DecisionRecord) => row.state === 'pending')) return;
      await store.decisions.create({
        id: `${playId}:menu:${String(all.length + 1)}`,
        scenarioId,
        playId,
        kind: DECISION_KINDS.menu,
        input: { playId, options: [...effect.options], reason: asJson(effect.reason) },
      });
    });
  }
}
