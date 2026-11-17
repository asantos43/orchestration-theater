// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  Conflict,
  type DecisionRecord,
  type JsonObject,
  InvalidInput,
  NotFound,
  type Store,
  supportsHistory,
  type Vcs,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import type { PlayRunner } from '../pipeline/index.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import type { DirectorReply, DirectorSessions } from './director.js';
import type { QuestionBoard } from './handlers.js';
import { DECISION_KINDS } from './play-effects.js';

/** The flow of a scenario the chat opens (the play flow: the Director opens plays in it). */
const CHAT_FLOW_ID = 'play';

export interface ProducerChannelOptions {
  readonly store: Store;
  readonly vcs: Vcs;
  readonly directors: DirectorSessions;
  readonly dispatcher: PromptDispatcher;
  readonly runner: PlayRunner;
  readonly board: QuestionBoard;
  readonly logger: Logger;
}

export interface OpenChatInput {
  /** The repository the Director works on. */
  readonly repo: string;
  /** The branch plays start from and deliver to. Default `main`. */
  readonly base?: string;
  /** A name for the scenario. Default: the name of the folder. */
  readonly name?: string;
}

/** What the Producer has to answer, as the chat shows it. */
export interface PendingAsk {
  readonly id: string;
  /** `producer_question` (the Director asks) or `producer_menu` (a play ran out of a counter). */
  readonly kind: string;
  readonly playId: string | null;
  readonly input: JsonObject;
}

export interface ChatPoll {
  readonly replies: readonly DirectorReply[];
  readonly asks: readonly PendingAsk[];
  readonly plays: readonly { readonly id: string; readonly state: string }[];
  /**
   * True while something is still going on that the Producer does not have to answer: the Director
   * has a turn or a prompt to go, or a play is in a state that moves by itself.
   */
  readonly busy: boolean;
}

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug === '' ? 'repo' : slug;
}

/** The id of the scenario of a repository: stable, so `ot chat` in the same folder returns to it. */
export function chatScenarioId(repo: string): string {
  const path = resolve(repo);
  const digest = createHash('sha1').update(path).digest('hex').slice(0, 8);
  return `chat-${slugOf(basename(path))}-${digest}`;
}

/**
 * The Producer's side of the daemon (decision N78, "ot chat" mínimo): opens the scenario and its
 * Director, puts the Producer's messages in the single queue (source `producer`), lists what the
 * Director said, and takes the Producer's answers to the questions and to the menu of
 * AWAITING_PRODUCER. The HTTP layer ({@link ProducerChannelServer}) and the tests call it.
 * [proposta] The channel is a loopback HTTP server apart from the MCP server, because the MCP
 * server is the tools of the Executors, behind per-attempt tokens.
 */
export class ProducerChannel {
  readonly #options: ProducerChannelOptions;

  constructor(options: ProducerChannelOptions) {
    this.#options = options;
  }

  /**
   * Makes sure the scenario of the repository exists and its Director is open. [proposta] `ot chat
   * --repo <folder>` is the way to get a scenario until the scenarios step (P12) has its own
   * commands; it makes a `project` scenario with the default flow.
   */
  async openChat(input: OpenChatInput): Promise<{ scenarioId: string; cursor: number }> {
    const { store, vcs, directors } = this.#options;
    const path = resolve(input.repo);
    const base = input.base ?? 'main';
    try {
      if (!supportsHistory(vcs)) throw new Error('the Vcs adapter cannot read refs');
      await vcs.resolveRef(path, base);
    } catch (error) {
      throw new InvalidInput(
        `"${path}" is not a git repository with a "${base}" branch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const scenarioId = chatScenarioId(path);
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      await store.scenarios.create({
        id: scenarioId,
        kind: 'project',
        flowId: CHAT_FLOW_ID,
        name: input.name ?? basename(path),
        folder: path,
        profile: 'software',
        baseBranch: base,
      });
    }
    await store.scenarioRepos.put({ scenarioId, path, mainBranch: base });
    await directors.ensure(scenarioId);
    const replies = directors.replies(scenarioId, 0);
    return { scenarioId, cursor: replies[replies.length - 1]?.seq ?? 0 };
  }

  /** Puts a message of the Producer in the queue; the Director gets it when its turn comes. */
  async send(scenarioId: string, text: string): Promise<void> {
    const { store, dispatcher, directors } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    if (text.trim() === '') throw new InvalidInput('The message is empty');
    await directors.ensure(scenarioId);
    await dispatcher.submit({ scenarioId, source: 'producer', text });
  }

  async poll(scenarioId: string, since: number): Promise<ChatPoll> {
    const { store, directors, board } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    const pending = await store.decisions.list({ scenarioId, states: ['pending'] });
    const asks: PendingAsk[] = [];
    for (const decision of pending) {
      const isMenu = decision.kind === DECISION_KINDS.menu;
      const isRecovery = decision.kind === DECISION_KINDS.recovery;
      const isQuestion = decision.kind === DECISION_KINDS.question && board.has(decision.id);
      if (!isMenu && !isQuestion && !isRecovery) continue;
      asks.push({
        id: decision.id,
        kind: decision.kind,
        playId: decision.playId,
        input: decision.input,
      });
    }
    const open = await store.plays.list({ scenarioId, open: true });
    const awaiting = new Set(
      asks.filter((ask) => ask.kind !== DECISION_KINDS.question).map((ask) => ask.playId),
    );
    const moving = open.some((play) => play.state !== 'NEED' && !awaiting.has(play.id));
    return {
      replies: directors.replies(scenarioId, since),
      asks,
      plays: open.map((play) => ({ id: play.id, state: play.state })),
      busy: (await directors.busy(scenarioId)) || moving || asks.some((a) => board.has(a.id)),
    };
  }

  /**
   * The Producer's answer to a question of the Director (`{answers}`) or to the menu of a play
   * that ran out of a counter (`{option, need?, reason?}`, 5.4). Anything else is the Director's.
   */
  async answer(decisionId: string, answer: JsonObject): Promise<void> {
    const { store, runner, board } = this.#options;
    const decision = await store.decisions.get(decisionId);
    if (decision === undefined) throw new NotFound(`There is no decision "${decisionId}"`);
    if (decision.state !== 'pending') {
      throw new Conflict(`The decision "${decisionId}" is already ${decision.state}`);
    }
    if (decision.kind === DECISION_KINDS.question) {
      if (!board.has(decisionId)) {
        await store.decisions.cancel(decisionId);
        throw new Conflict(`Nobody waits for the answer to "${decisionId}" any more`);
      }
      await store.decisions.decide(decisionId, { answer, decidedBy: 'producer' });
      board.resolve(decisionId, answer);
      return;
    }
    if (decision.kind === DECISION_KINDS.menu && decision.playId !== null) {
      try {
        await runner.send(decision.playId, { ...answer, type: 'PRODUCER_CHOSE' });
      } catch (error) {
        if (error instanceof Conflict) await store.decisions.cancel(decisionId);
        throw error;
      }
      await store.decisions.decide(decisionId, { answer, decidedBy: 'producer' });
      return;
    }
    if (decision.kind === DECISION_KINDS.recovery && decision.playId !== null) {
      await this.#answerRecovery(decision, answer);
      return;
    }
    throw new InvalidInput(`The decision "${decisionId}" is not for the Producer to answer`);
  }

  /**
   * The Producer says whether an effect the start-up could not check happened (5.21): `not_done`
   * lets the play do it again (the next idempotency key), `done` takes it as done with the result
   * the Producer gives (`result`, or `reason` holding it as JSON), because the play needs what
   * the effect produced (the number and the address of a PR, say). [proposta]
   */
  async #answerRecovery(decision: DecisionRecord, answer: JsonObject): Promise<void> {
    const { store, runner } = this.#options;
    const playId = decision.playId;
    const key = decision.input.key;
    if (playId === null || typeof key !== 'string') {
      throw new InvalidInput(`The decision "${decision.id}" does not say which effect it is about`);
    }
    const record = await store.sideEffects.get(key);
    if (record === undefined) throw new NotFound(`There is no side effect "${key}"`);
    if (answer.option === 'not_done') {
      await store.sideEffects.resolve(key, { state: 'not_done', verifier: 'producer' });
    } else if (answer.option === 'done') {
      const result = recoveryResultOf(answer);
      if (result === undefined) {
        throw new InvalidInput(
          'To say the effect is done, give what it produced as a JSON object (result)',
        );
      }
      await store.sideEffects.resolve(key, { state: 'done', result, verifier: 'producer' });
    } else {
      throw new InvalidInput('The answer must be "done" or "not_done"');
    }
    await store.decisions.decide(decision.id, { answer, decidedBy: 'producer' });
    await runner.resume(playId);
  }
}

function recoveryResultOf(answer: JsonObject): JsonObject | undefined {
  const given = answer.result ?? answer.reason;
  let value: unknown = given;
  if (typeof given === 'string') {
    try {
      value = JSON.parse(given);
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
