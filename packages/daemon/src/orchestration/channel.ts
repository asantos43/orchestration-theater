// SPDX-License-Identifier: MPL-2.0
import {
  type AttachmentRecord,
  Conflict,
  type DecisionRecord,
  type IdeaRecord,
  type JsonObject,
  InvalidInput,
  NotFound,
  type Store,
} from '@otheater/core';
import type { ScenarioSystemMessagePayload } from '@otheater/protocol';
import { z } from 'zod';
import type { DrainResult, IdeaQueueService } from '../ideas/index.js';
import { IDEA_GROUP_DECISION } from '../ideas/index.js';
import type { Logger } from '../logger.js';
import type { PlayRunner } from '../pipeline/index.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import type { AttachmentService } from '../scenarios/attachments.js';
import { type ScenarioService, projectScenarioId } from '../scenarios/service.js';
import type { DirectorReply, DirectorSessions } from './director.js';
import type { QuestionBoard } from './handlers.js';
import { DECISION_KINDS } from './play-effects.js';
import type { ChatPresence } from './presence.js';

export interface ProducerChannelOptions {
  readonly store: Store;
  readonly scenarios: ScenarioService;
  readonly attachments: AttachmentService;
  readonly directors: DirectorSessions;
  readonly dispatcher: PromptDispatcher;
  readonly runner: PlayRunner;
  /** The idea queue of the scenarios (5.20): `/idea` and the approval of a group. */
  readonly ideas?: IdeaQueueService;
  readonly board: QuestionBoard;
  readonly logger: Logger;
  /** Told that a chat polled a scenario: that is what makes a play watched. */
  readonly presence?: ChatPresence;
}

export interface OpenChatInput {
  /** The type of the scenario (a key of the scenario type registry). Default `project`. */
  readonly type?: string;
  /** The repository the Director works on: required by a `project`, not used by a `chat`. */
  readonly repo?: string;
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

/** An idea as the chat shows it. */
export interface IdeaView {
  readonly id: string;
  readonly text: string;
  readonly area: string | null;
  readonly state: string;
  readonly groupId: string | null;
  readonly playId: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly reason: string | null;
}

export function ideaViewOf(idea: IdeaRecord): IdeaView {
  return {
    id: idea.id,
    text: idea.text,
    area: idea.area,
    state: idea.state,
    groupId: idea.groupId,
    playId: idea.playId,
    prNumber: idea.prNumber,
    prUrl: idea.prUrl,
    reason: idea.reason,
  };
}

/** What `/idea` can do (5.20): add an idea, list the queue, drain it now, or settle one idea. */
export type IdeaCommand =
  | { readonly action: 'add'; readonly text: string; readonly area?: string | undefined }
  | { readonly action: 'list' }
  | { readonly action: 'drain' }
  | { readonly action: 'discard' | 'defer'; readonly id: string; readonly reason: string }
  | { readonly action: 'requeue'; readonly id: string };

export interface IdeaCommandResult {
  /** The idea the command acted on (`add`, `discard`, `defer`, `requeue`). */
  readonly idea?: IdeaView;
  /** The whole queue of the scenario after the command. */
  readonly ideas: readonly IdeaView[];
  /** `drain`: what the pass did. */
  readonly drain?: DrainResult;
}

/** The answer to a group of ideas that waits for approval. */
const GroupAnswerBody = z.discriminatedUnion('option', [
  z.strictObject({ option: z.literal('approve') }),
  z.strictObject({
    option: z.literal('edit'),
    need: z.string().optional(),
    ideaIds: z.array(z.string()).optional(),
  }),
  z.strictObject({ option: z.literal('refuse'), reason: z.string().optional() }),
]);

export interface ChatPoll {
  readonly replies: readonly DirectorReply[];
  readonly asks: readonly PendingAsk[];
  readonly plays: readonly { readonly id: string; readonly state: string }[];
  /**
   * The system messages of the daemon for this scenario that nobody has taken yet, oldest first
   * (the reconciliation of the start-up, 5.21). Each one is handed out once.
   */
  readonly notices: readonly ScenarioSystemMessagePayload[];
  /**
   * True while something is still going on that the Producer does not have to answer: the Director
   * has a turn or a prompt to go, or a play is in a state that moves by itself.
   */
  readonly busy: boolean;
}

/** The id of the scenario of a repository: stable, so `ot chat` in the same folder returns to it. */
export const chatScenarioId = projectScenarioId;

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
  readonly #notices = new Map<string, ScenarioSystemMessagePayload[]>();

  constructor(options: ProducerChannelOptions) {
    this.#options = options;
  }

  /**
   * Keeps a system message for the chat of its scenario until the next poll takes it. [proposta]
   * In memory only: the record is the `scenario.system_message` event, and a new start writes its
   * own, so a message nobody read before another restart is not shown late.
   */
  notify(notice: ScenarioSystemMessagePayload): void {
    const waiting = this.#notices.get(notice.scenarioId) ?? [];
    waiting.push(notice);
    this.#notices.set(notice.scenarioId, waiting);
  }

  /**
   * Makes sure the scenario exists and its Director is open. [proposta] `ot chat` opens a
   * `project` scenario on a repository (the default, as in P8) or, with `type: 'chat'`, a generic
   * chat with a folder of its own; the type comes from the scenario type registry (5.20).
   */
  async openChat(input: OpenChatInput): Promise<{ scenarioId: string; cursor: number }> {
    const { scenarios, directors } = this.#options;
    const { scenario } = await scenarios.create({
      type: input.type ?? 'project',
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.base === undefined ? {} : { base: input.base }),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    const scenarioId = scenario.id;
    await directors.ensure(scenarioId);
    const replies = directors.replies(scenarioId, 0);
    return { scenarioId, cursor: replies[replies.length - 1]?.seq ?? 0 };
  }

  /**
   * Attaches a file of the Producer's machine (or a pasted text) to the scenario: it becomes
   * `A<n>`, which the Director and the consultant read with `read_attachment` (5.20).
   */
  async attach(
    scenarioId: string,
    input:
      | { readonly path: string; readonly mode?: 'copy' | 'reference' }
      | { readonly text: string; readonly name?: string },
  ): Promise<AttachmentRecord> {
    const { store, attachments } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    return 'text' in input
      ? attachments.addText(scenarioId, input)
      : attachments.addFile(scenarioId, input);
  }

  /** Puts a message of the Producer in the queue; the Director gets it when its turn comes. */
  async send(
    scenarioId: string,
    text: string,
    attachmentIds: readonly string[] = [],
  ): Promise<void> {
    const { store, dispatcher, directors } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    if (text.trim() === '') throw new InvalidInput('The message is empty');
    // [proposta] The message names its attachments (id, name, type, size); their content is read
    // with `read_attachment`, never pasted into the prompt.
    const lines: string[] = [];
    for (const id of attachmentIds) {
      const record = await store.attachments.get(scenarioId, id);
      if (record === undefined)
        throw new NotFound(`There is no attachment "${id}" in this scenario`);
      lines.push(`- ${record.id}: ${record.name} (${record.mime}, ${String(record.size)} bytes)`);
    }
    const body = lines.length === 0 ? text : `${text}\n\nAttachments:\n${lines.join('\n')}`;
    await directors.ensure(scenarioId);
    await dispatcher.submit({ scenarioId, source: 'producer', text: body });
  }

  async poll(scenarioId: string, since: number): Promise<ChatPoll> {
    const { store, directors, board, presence } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    presence?.touch(scenarioId);
    const pending = await store.decisions.list({ scenarioId, states: ['pending'] });
    const asks: PendingAsk[] = [];
    for (const decision of pending) {
      const isMenu = decision.kind === DECISION_KINDS.menu;
      const isRecovery = decision.kind === DECISION_KINDS.recovery;
      const isGroup = decision.kind === IDEA_GROUP_DECISION;
      const isQuestion = decision.kind === DECISION_KINDS.question && board.has(decision.id);
      if (!isMenu && !isQuestion && !isRecovery && !isGroup) continue;
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
    const notices = this.#notices.get(scenarioId) ?? [];
    this.#notices.delete(scenarioId);
    return {
      replies: directors.replies(scenarioId, since),
      asks,
      plays: open.map((play) => ({ id: play.id, state: play.state })),
      notices,
      busy:
        (await directors.busy(scenarioId)) ||
        moving ||
        this.#options.ideas?.busy(scenarioId) === true ||
        asks.some((a) => board.has(a.id)),
    };
  }

  #ideas(): IdeaQueueService {
    const { ideas } = this.#options;
    if (ideas === undefined) throw new InvalidInput('This daemon has no idea queue');
    return ideas;
  }

  /** `/idea`: the idea queue of the scenario (5.20). */
  async idea(scenarioId: string, command: IdeaCommand): Promise<IdeaCommandResult> {
    const { store } = this.#options;
    const ideas = this.#ideas();
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    const own = async (id: string): Promise<void> => {
      const found = await store.ideas.get(id);
      if (found?.scenarioId !== scenarioId) {
        throw new NotFound(`There is no idea "${id}" in this scenario`);
      }
    };
    let idea: IdeaRecord | undefined;
    let drain: DrainResult | undefined;
    switch (command.action) {
      case 'add':
        idea = await ideas.add(scenarioId, {
          text: command.text,
          source: 'chat',
          ...(command.area === undefined ? {} : { area: command.area }),
        });
        break;
      case 'list':
        break;
      case 'drain':
        drain = await ideas.drain(scenarioId);
        break;
      case 'discard':
        await own(command.id);
        idea = await ideas.discard(command.id, command.reason);
        break;
      case 'defer':
        await own(command.id);
        idea = await ideas.defer(command.id, command.reason);
        break;
      case 'requeue':
        await own(command.id);
        idea = await ideas.requeue(command.id);
        break;
    }
    return {
      ...(idea === undefined ? {} : { idea: ideaViewOf(idea) }),
      ideas: (await ideas.list(scenarioId)).map(ideaViewOf),
      ...(drain === undefined ? {} : { drain }),
    };
  }

  /**
   * The Producer's answer to a question of the Director (`{answers}`), to the menu of a play
   * that ran out of a counter (`{option, need?, reason?}`, 5.4) or to a group of ideas that waits
   * for approval (`{option: approve|edit|refuse}`, 5.20). Anything else is the Director's.
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
    if (decision.kind === IDEA_GROUP_DECISION) {
      const parsed = GroupAnswerBody.safeParse(answer);
      if (!parsed.success) {
        throw new InvalidInput(
          'Answer a group of ideas with option "approve", "edit" (need and/or ideaIds) or "refuse" (reason)',
        );
      }
      const given = parsed.data;
      await this.#ideas().answerGroup(
        decisionId,
        given.option === 'edit'
          ? {
              option: 'edit',
              ...(given.need === undefined ? {} : { need: given.need }),
              ...(given.ideaIds === undefined ? {} : { ideaIds: given.ideaIds }),
            }
          : given.option === 'refuse'
            ? { option: 'refuse', ...(given.reason === undefined ? {} : { reason: given.reason }) }
            : { option: 'approve' },
      );
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
