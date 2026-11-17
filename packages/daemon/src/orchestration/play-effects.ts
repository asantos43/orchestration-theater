// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AdapterUnavailable,
  assemblePrefix,
  attemptBranch,
  type AttemptRecord,
  contractKey,
  type Demand,
  type DecisionRecord,
  type EventEnvelope,
  InvalidInput,
  integrationBranch,
  type JsonValue,
  NotFound,
  parseScript,
  PLAN_KEY,
  playBranch,
  type PromptSource,
  type Registries,
  type Script,
  SCRIPT_KEY,
  type Store,
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
import { clarifyPrompt, judgePrompt, stagePrompt } from './prompts.js';
import { executorOf, policyOf, sessionSettingsOf } from './roles.js';

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

// What the roles send through their `submit_*` tool (the tools take a free record).
const PlanOutput = z.looseObject({
  plan: z.string().min(1),
  openQuestions: z.array(z.string().min(1)).default([]),
});
const ReviewOutput = z.looseObject({ approved: z.boolean(), reason: z.string().optional() });
const ScriptOutput = z.looseObject({ script: z.unknown() });

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
}

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
      case 'verify_demand':
      case 'rebase_dependents':
        // Judgment points 2 and 8 (partial work, rebase of dependents) are not reachable until
        // the Director's answers for them exist (P12); the effect is logged and not run.
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
    const parsed = PlanOutput.safeParse(value);
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
      policy: policyOf(effect.role),
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
        const plan = PlanOutput.parse(output);
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
        const review = ReviewOutput.parse(output);
        await this.#send(playId, generation, {
          type: 'PLAN_REVIEWED',
          approved: review.approved,
          ...(review.reason === undefined ? {} : { reason: clip(review.reason) }),
        });
        return;
      }
      case 'SCRIPTING':
        await this.#scriptResult(scope, generation, ScriptOutput.parse(output).script);
        return;
      case 'REVIEWING_SCRIPT': {
        const review = ReviewOutput.parse(output);
        await this.#send(playId, generation, {
          type: 'SCRIPT_REVIEWED',
          approved: review.approved,
          ...(review.reason === undefined ? {} : { reason: clip(review.reason) }),
        });
        return;
      }
      case 'CRITIQUING': {
        const review = ReviewOutput.parse(output);
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
      } else if (existing.state !== 'pending') {
        // A new script starts every demand over (the work of the old one is not trusted).
        await store.demands.update(playId, demand.id, { state: 'pending' });
      }
    }
    await this.#send(playId, generation, {
      type: 'SCRIPT_VALIDATED',
      valid: true,
      demandIds: script.demands.map((demand) => demand.id),
    });
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
      const plan = PlanOutput.safeParse(value);
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
      const base = dependency?.branch ?? playBranch(playId);
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
        policy: policyOf('actor'),
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
      await this.#send(playId, generation, { type: 'DEMAND_APPROVED', demandId: demand.id });
    } catch (error) {
      await store.demands.update(playId, demand.id, { state: 'failed' }).catch(() => undefined);
      await failed(messageOf(error));
    }
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
      const result = await workspace.integrate({ repo: repo.path, playId, script, approved });
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
    const need = await this.#needOf(playId);
    const title = (need.split('\n')[0] ?? need).trim().slice(0, 72) || `Play ${playId}`;
    const notes = [
      `Delivered by OTheater (play ${playId}).`,
      effect.partial ? 'Only the approved demands are included.' : undefined,
      effect.criticWaived ? 'The Critic was waived for this play.' : undefined,
      `## Need\n\n${need}`,
    ].filter((line): line is string => line !== undefined);
    const result = await workspace.deliver({
      repo: repo.path,
      playId,
      base: repo.mainBranch,
      ...(repo.remote === undefined ? {} : { remote: repo.remote }),
      title,
      body: notes.join('\n\n'),
      configMode: config.delivery.mode,
      allowDirectMerge: config.delivery.allow_direct_merge,
      // [proposta] The ask of `delivery.mode: ask` is the chat's (P12): until then the play is not
      // attended, and `ask` falls back to a pull request.
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
        input: { playId, options: [...effect.options], reason: effect.reason },
      });
    });
  }
}
