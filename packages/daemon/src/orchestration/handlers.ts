// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  Conflict,
  type askProducerInput,
  type JsonObject,
  type JsonValue,
  NotFound,
  renderStateSummary,
  stateSummaryOf,
  type Store,
} from '@otheater/core';
import type { SHELL_ASK_SOURCE, ShellAskMark } from '@otheater/protocol';
import type { z } from 'zod';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { producerQuestionErrors } from '../mcp/ask-producer.js';
import { ToolFailure, type ToolCall, type ToolHandlers } from '../mcp/handlers.js';
import {
  answerGuide,
  answerProblems,
  judgmentPoint,
  type JudgmentPointId,
  type PlayRunner,
} from '../pipeline/index.js';
import type { ChatFlow } from '../scenarios/chat-flow.js';
import type { Workspace } from '../workspace/index.js';
import type { DirectorSessions } from './director.js';
import { openPlayFromNeed } from './open-play.js';
import { DECISION_KINDS } from './play-effects.js';
import type { RoleSelection, RoleWait } from './role-selection.js';

/** The tools of the Director that the orchestration answers (P8). */
export const ORCHESTRATION_TOOL_NAMES = [
  'next_action',
  'status',
  'decide',
  'open_play',
  'ask_producer',
] as const;

/** The blackboard key with what the Producer answered to the questions of the plan. */
export const CLARIFICATIONS_KEY = 'clarifications';

/**
 * The questions of `ask_producer` that wait for the Producer. The handler holds the Director's
 * call open until the answer comes ({@link QuestionBoard.wait}); the channel resolves it. A
 * question is answered once, and everything pending ends with the daemon ({@link abortAll}).
 */
export class QuestionBoard {
  readonly #waiting = new Map<
    string,
    { resolve: (answer: JsonValue) => void; reject: (reason: Error) => void }
  >();

  /** True while a Director call waits for the answer of this decision. */
  has(decisionId: string): boolean {
    return this.#waiting.has(decisionId);
  }

  wait(decisionId: string): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      this.#waiting.set(decisionId, { resolve, reject });
    });
  }

  /** Hands the answer to the Director's call; false when nobody waits for it any more. */
  resolve(decisionId: string, answer: JsonValue): boolean {
    const waiter = this.#waiting.get(decisionId);
    if (waiter === undefined) return false;
    this.#waiting.delete(decisionId);
    waiter.resolve(answer);
    return true;
  }

  abortAll(reason: string): void {
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    for (const waiter of waiting) waiter.reject(new Error(reason));
  }
}

/** What the handlers need once the daemon has composed everything (they are registered earlier). */
export interface OrchestrationRuntime {
  readonly store: Store;
  readonly runner: PlayRunner;
  /** `undefined` while the daemon has no code host. */
  readonly workspace: Workspace | undefined;
  readonly directors: DirectorSessions;
  readonly config: DaemonConfig;
  readonly logger: Logger;
  /** The state machine of the `chat` flow (P12): told when a question to the Producer opens or ends. */
  readonly chatFlow?: ChatFlow | undefined;
  /** The demands that wait for an Executor (P16), for what `status` says. */
  readonly selection?: Pick<RoleSelection, 'waiting'> | undefined;
  /** The gate of the full disk: `open_play` is refused while it is closed (Phase 11, P5). */
  readonly disk?: { paused(): boolean } | undefined;
}

/** "the actor waiting for quota of claude-code/a (demand d1)", for the Director. */
function waitLineOf(wait: RoleWait): string {
  const demand = wait.demandId === null ? '' : ` (demand ${wait.demandId})`;
  return `the ${wait.role} is ${wait.message}${demand}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The answer of a decision is a JSON object: another value is kept under `answer`. */
function asObject(value: JsonValue): JsonObject {
  return isRecord(value) ? value : { answer: value };
}

function notReady(): ToolFailure {
  return new ToolFailure(
    'not_ready',
    'The daemon is still starting (or already stopping): try again in a moment.',
  );
}

/**
 * The handlers of the Director's tools that move a play: `next_action`, `status`, `decide`,
 * `open_play` and `ask_producer` (architecture 5.3 and 5.4). They are registered before the MCP
 * server starts, and the runtime is bound when the rest of the daemon exists.
 *
 * Every call is tied to a scenario through the Director session it came from
 * ({@link DirectorSessions.scenarioOf}); a caller that is not one gets `no_scenario`.
 */
export class OrchestrationHandlers {
  readonly board = new QuestionBoard();
  #runtime: OrchestrationRuntime | undefined;

  /** The runtime is handed in when the daemon is composed; `undefined` unbinds it (shutdown). */
  bind(runtime: OrchestrationRuntime | undefined): void {
    this.#runtime = runtime;
  }

  /** Registers the five handlers, skipping a name that already has one. */
  register(handlers: ToolHandlers): ToolHandlers {
    const mine: Record<(typeof ORCHESTRATION_TOOL_NAMES)[number], (call: ToolCall) => unknown> = {
      next_action: (call) => this.#with(call, (rt, scenarioId) => this.#nextAction(rt, scenarioId)),
      status: (call) =>
        this.#with(call, (rt, scenarioId) =>
          this.#status(rt, scenarioId, (call.input as { play?: string }).play),
        ),
      decide: (call) =>
        this.#with(call, (rt, scenarioId) =>
          this.#decide(rt, scenarioId, call.input as { decisionId: string; payload: JsonValue }),
        ),
      open_play: (call) =>
        this.#with(call, (rt, scenarioId) =>
          this.#openPlay(rt, scenarioId, (call.input as { need: string }).need),
        ),
      ask_producer: (call) =>
        this.#with(call, (rt, scenarioId) =>
          this.#askProducer(rt, scenarioId, call.input as z.infer<typeof askProducerInput>),
        ),
    };
    for (const [name, handler] of Object.entries(mine)) {
      if (!handlers.has(name)) handlers.register(name, handler);
    }
    return handlers;
  }

  #with(
    call: ToolCall,
    run: (runtime: OrchestrationRuntime, scenarioId: string) => unknown,
  ): unknown {
    const runtime = this.#runtime;
    if (runtime === undefined) return notReady();
    const scenarioId = runtime.directors.scenarioOf(call.caller.attemptId);
    if (scenarioId === undefined) {
      return new ToolFailure(
        'no_scenario',
        `${call.tool.name} is a tool of the Director of a scenario, and this session is not one.`,
      );
    }
    return run(runtime, scenarioId);
  }

  /** The judgment points and questions the Director has to settle, and where the scenario stands. */
  async #nextAction(rt: OrchestrationRuntime, scenarioId: string): Promise<JsonObject> {
    const pending = await rt.store.decisions.list({ scenarioId, states: ['pending'] });
    const mine: JsonObject[] = [];
    for (const decision of pending) {
      const settledByDirector =
        decision.kind.startsWith(DECISION_KINDS.judgePrefix) ||
        decision.kind === DECISION_KINDS.clarify;
      if (!settledByDirector) continue;
      if (decision.playId !== null) {
        const play = await rt.store.plays.get(decision.playId);
        if (play?.finishedAt !== null) continue;
      }
      // A judgment point shows the shape of its answer: the schema and one valid example.
      const guide = decision.kind.startsWith(DECISION_KINDS.judgePrefix)
        ? answerGuide(
            decision.kind.slice(DECISION_KINDS.judgePrefix.length) as JudgmentPointId,
            decision.input,
          )
        : undefined;
      mine.push({
        id: decision.id,
        kind: decision.kind,
        playId: decision.playId,
        input: decision.input,
        ...(guide === undefined
          ? {}
          : {
              answer: { schema: guide.schema as JsonObject, example: guide.example as JsonObject },
            }),
      });
    }
    const summary = renderStateSummary(await stateSummaryOf(rt.store, scenarioId));
    return {
      decisions: mine,
      hint:
        mine.length === 0
          ? 'Nothing is waiting for you. Answer the Producer, or wait for the next prompt.'
          : 'Settle each decision with `decide {decisionId, payload}`; the payload of a judgment point follows its `answer.schema` (see `answer.example`).',
      summary,
    };
  }

  async #status(
    rt: OrchestrationRuntime,
    scenarioId: string,
    playId: string | undefined,
  ): Promise<JsonObject | ToolFailure> {
    const waits = (rt.selection?.waiting(scenarioId) ?? []).filter(
      (wait) => playId === undefined || wait.playId === playId,
    );
    // [proposta] Said only while something waits: "waiting for quota of claude-code/a (the Actor)".
    const waitingFor = waits.length === 0 ? {} : { waitingFor: waits.map(waitLineOf) };
    if (playId === undefined) {
      const plays = await rt.store.plays.list({ scenarioId });
      return {
        plays: plays.map((play) => ({
          id: play.id,
          state: play.state,
          need: play.need,
          finished: play.finishedAt !== null,
        })),
        ...waitingFor,
      };
    }
    const play = await rt.store.plays.get(playId);
    if (play?.scenarioId !== scenarioId) {
      return new ToolFailure('not_found', `The play "${playId}" does not exist in this scenario.`);
    }
    const demands = await rt.store.demands.list({ playId });
    return {
      id: play.id,
      state: play.state,
      need: play.need,
      counters: play.counters,
      finished: play.finishedAt !== null,
      demands: demands.map((demand) => ({
        id: demand.id,
        title: demand.title,
        state: demand.state,
        dependsOn: demand.dependsOn,
      })),
      ...waitingFor,
    };
  }

  /**
   * `decide`: settles a decision of the Director. A `judge.<point>` answer is validated by the
   * point and goes to the machine as `JUDGED`; the answer of `clarify` goes to the blackboard
   * and the play moves on (`QUESTIONS_ANSWERED`). The menu of AWAITING_PRODUCER and the
   * questions of `ask_producer` are the Producer's, never the Director's (5.4).
   */
  async #decide(
    rt: OrchestrationRuntime,
    scenarioId: string,
    input: { decisionId: string; payload: JsonValue },
  ): Promise<JsonObject | ToolFailure> {
    const decision = await rt.store.decisions.get(input.decisionId);
    if (decision?.scenarioId !== scenarioId) {
      return new ToolFailure('not_found', `The decision "${input.decisionId}" does not exist.`);
    }
    if (decision.state !== 'pending') {
      return new ToolFailure(
        'already_decided',
        `The decision "${decision.id}" is ${decision.state}; call next_action for what waits.`,
      );
    }
    const { playId } = decision;
    if (
      decision.kind === DECISION_KINDS.menu ||
      decision.kind === DECISION_KINDS.question ||
      decision.kind === DECISION_KINDS.recovery
    ) {
      return new ToolFailure(
        'producer_only',
        'Only the Producer answers this one; it is shown to them in the chat.',
      );
    }
    if (playId === null) {
      return new ToolFailure('not_found', `The decision "${decision.id}" has no play.`);
    }
    if (decision.kind === DECISION_KINDS.clarify) {
      await rt.store.blackboard.put({
        playId,
        key: CLARIFICATIONS_KEY,
        value: { decisionId: decision.id, answer: input.payload },
        author: 'director',
      });
      return this.#settle(
        rt,
        decision.id,
        playId,
        { type: 'QUESTIONS_ANSWERED' },
        asObject(input.payload),
      );
    }
    if (!decision.kind.startsWith(DECISION_KINDS.judgePrefix)) {
      return new ToolFailure('unsupported', `The decision kind "${decision.kind}" has no answer.`);
    }
    const point = decision.kind.slice(DECISION_KINDS.judgePrefix.length);
    if (judgmentPoint(point) === undefined) {
      return new ToolFailure('unsupported', `The point "${point}" is not a judgment point.`);
    }
    // Checked before the machine sees it: the machine refuses a classification naming a demand
    // the script does not have, and a refused event would read as a stale decision.
    const payload = input.payload;
    const problems = isRecord(payload)
      ? answerProblems(point as JudgmentPointId, payload, decision.input)
      : ['the payload must be a JSON object'];
    if (!isRecord(payload) || problems.length > 0) {
      const example = answerGuide(point as JudgmentPointId, decision.input)?.example;
      return new ToolFailure(
        'invalid_answer',
        `The payload does not fit the point "${point}": ${problems.join('; ')}.${
          example === undefined ? '' : ` A valid payload looks like ${JSON.stringify(example)}.`
        } \`next_action\` shows the full schema under "answer".`,
      );
    }
    const demandId =
      typeof decision.input.demandId === 'string' ? decision.input.demandId : undefined;
    return this.#settle(
      rt,
      decision.id,
      playId,
      {
        type: 'JUDGED',
        point,
        ...(demandId === undefined ? {} : { demandId }),
        answer: payload,
      },
      payload,
    );
  }

  /** Sends the event of the answer; the decision is marked decided only when the machine took it. */
  async #settle(
    rt: OrchestrationRuntime,
    decisionId: string,
    playId: string,
    event: unknown,
    answer: JsonObject,
  ): Promise<JsonObject | ToolFailure> {
    try {
      await rt.runner.send(playId, event);
    } catch (error) {
      if (error instanceof Conflict || error instanceof NotFound) {
        // The play left the state that asked (cancelled, restarted): the question is stale.
        await rt.store.decisions.cancel(decisionId).catch(() => undefined);
        return new ToolFailure(
          'stale',
          `The decision "${decisionId}" no longer applies: the play moved on. Call next_action.`,
        );
      }
      return new ToolFailure(
        'invalid_answer',
        error instanceof Error ? error.message : 'The answer was refused.',
      );
    }
    await rt.store.decisions.decide(decisionId, { answer, decidedBy: 'director' });
    return { ok: true };
  }

  /** `open_play`: creates the play of the scenario, its base branch, and starts it. */
  async #openPlay(
    rt: OrchestrationRuntime,
    scenarioId: string,
    need: string,
  ): Promise<JsonObject | ToolFailure> {
    const opened = await openPlayFromNeed(rt, scenarioId, need);
    if (!opened.ok) return new ToolFailure(opened.code, opened.message);
    return { playId: opened.playId };
  }

  /**
   * Opens a question to the Producer for something other than the Director, today the approval of
   * an action of the browser (architecture 5.19, `browser.write_approval`). It is the same decision
   * as `ask_producer` (kind `producer_question`, the same prompt queue, the same answer `{answers}`),
   * so the Producer answers it where they answer the Director's questions. Returns the id at once
   * and the answer as a promise, which rejects when the daemon stops (the decision is then
   * cancelled). `undefined` while the daemon is still starting: nobody can be asked, which a caller
   * reads as a refusal. [proposta]
   */
  async openApproval(
    scenarioId: string,
    input: z.infer<typeof askProducerInput> & {
      source?: typeof SHELL_ASK_SOURCE;
      shell?: ShellAskMark;
    },
  ): Promise<{ decisionId: string; answer: Promise<JsonValue> } | undefined> {
    const rt = this.#runtime;
    if (rt === undefined) return undefined;
    const id = `${scenarioId}:ask:${randomUUID().slice(0, 8)}`;
    await rt.store.decisions.create({
      id,
      scenarioId,
      kind: DECISION_KINDS.question,
      input: {
        questions: JSON.parse(JSON.stringify(input.questions)) as JsonValue,
        // The mark of the question of `chat.shell_command.context: ask` (P26, N205).
        ...(input.source === undefined || input.shell === undefined
          ? {}
          : { source: input.source, shell: input.shell }),
      },
    });
    const waiting = this.board.wait(id);
    await rt.chatFlow?.sync(scenarioId, 'ask_producer', { decisionId: id });
    const answer = waiting.then(
      async (value) => {
        await rt.chatFlow?.sync(scenarioId, 'producer_answered', { decisionId: id });
        return isRecord(value) && 'answers' in value ? (value.answers ?? null) : value;
      },
      async (error: unknown) => {
        await rt.store.decisions.cancel(id).catch(() => undefined);
        await rt.chatFlow
          ?.sync(scenarioId, 'ask_cancelled', { decisionId: id })
          .catch(() => undefined);
        throw error;
      },
    );
    return { decisionId: id, answer };
  }

  /**
   * `ask_producer`: records the questions as a decision for the Producer and holds the call open
   * until they answer (or the daemon stops). [proposta] A blocking call keeps the Director's turn,
   * and with it the single queue, until the answer: the Producer is the only one who can unblock
   * what comes after.
   */
  async #askProducer(
    rt: OrchestrationRuntime,
    scenarioId: string,
    input: z.infer<typeof askProducerInput>,
  ): Promise<JsonObject | ToolFailure> {
    const errors = producerQuestionErrors(input, 'choices');
    if (errors.length > 0) return new ToolFailure('invalid_questions', errors.join('\n'));
    const id = `${scenarioId}:ask:${randomUUID().slice(0, 8)}`;
    await rt.store.decisions.create({
      id,
      scenarioId,
      kind: DECISION_KINDS.question,
      input: { questions: JSON.parse(JSON.stringify(input.questions)) as JsonValue },
    });
    const waiting = this.board.wait(id);
    await rt.chatFlow?.sync(scenarioId, 'ask_producer', { decisionId: id });
    try {
      const answer = await waiting;
      await rt.chatFlow?.sync(scenarioId, 'producer_answered', { decisionId: id });
      // The channel sends `{answers: [...]}`; anything else is passed on whole.
      return {
        answers: isRecord(answer) && 'answers' in answer ? (answer.answers ?? null) : answer,
      };
    } catch (error) {
      await rt.store.decisions.cancel(id).catch(() => undefined);
      await rt.chatFlow
        ?.sync(scenarioId, 'ask_cancelled', { decisionId: id })
        .catch(() => undefined);
      return new ToolFailure(
        'daemon_stopping',
        error instanceof Error ? error.message : 'The question was not answered.',
      );
    }
  }
}
