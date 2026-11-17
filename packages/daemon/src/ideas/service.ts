// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  assemblePrefix,
  checkIdeaGroup,
  Conflict,
  type EventEnvelope,
  ideaGroupOutput,
  type IdeaGroupOutput,
  type IdeaRecord,
  InvalidInput,
  type JsonObject,
  NotFound,
  type PlayRecord,
  type PromptSource,
  type Registries,
  type Store,
  type Vcs,
} from '@otheater/core';
import {
  buildDaemonEvent,
  type DaemonEventPayloads,
  type DaemonEventType,
} from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import type { AttemptRunner } from '../execution/attempt-runner.js';
import type { Logger } from '../logger.js';
import { type PlayOpening, openPlayFromNeed } from '../orchestration/open-play.js';
import { executorOf, policyOf, sessionSettingsOf } from '../orchestration/roles.js';
import type { DataPaths } from '../paths.js';
import { type IdeaSettings, ideaSettingsOf } from './settings.js';

/** The role that groups the queue. */
export const GROUPING_ROLE = 'author';

/** The kind of the decision that holds a group until the Producer approves it. */
export const IDEA_GROUP_DECISION = 'ideas.group';

/** How many groupings one pass of the queue may make (a guard against a loop that never ends). */
const MAX_GROUPINGS_PER_PASS = 20;

export interface IdeaQueueServiceOptions {
  readonly store: Store;
  readonly vcs: Vcs;
  readonly runner: Pick<AttemptRunner, 'run'>;
  readonly registries: Registries;
  readonly prompts: PromptSource;
  readonly config: DaemonConfig;
  readonly paths: Pick<DataPaths, 'profiles'>;
  /** What opening a play needs; the same the Director's `open_play` uses. */
  readonly opening: PlayOpening;
  readonly logger: Logger;
}

export type IdeaAddInput = {
  readonly text: string;
  readonly area?: string | undefined;
  readonly source?: 'chat' | 'tui' | 'terminal' | 'author' | 'import' | undefined;
};

/** What one pass of the queue did, for the command that asked for it. */
export interface DrainResult {
  /** Groups the Author made (each one is waiting for approval or became a play). */
  readonly groups: number;
  /** Why the pass stopped before the queue was empty, when it did. */
  readonly stopped: string | undefined;
}

/** What the Producer answers to a group that waits for the approval. */
export type GroupAnswer =
  | { readonly option: 'approve' }
  | { readonly option: 'edit'; readonly need?: string; readonly ideaIds?: readonly string[] }
  | { readonly option: 'refuse'; readonly reason?: string };

/**
 * The idea queue of a scenario (architecture 5.20, decision N91). Ideas wait `queued`; a pass of
 * the queue runs the Author on them (`group_ideas`, the stage tool `submit_idea_group`), which
 * answers with the next group, the ideas it leaves out and the ones it drops, postpones or splits.
 * The group becomes the need of a play by the same path the Director's `open_play` takes, at once
 * (`ideas.grouping_approval: auto`) or after the Producer approves it (`ask`). When the play ends,
 * its ideas are `done`, linked to the play and to the PR, or go back to the queue.
 * [proposta] The details below the architecture's text.
 */
export class IdeaQueueService {
  readonly #options: IdeaQueueServiceOptions;
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #background = new Set<Promise<void>>();
  /** Scenarios where a pass stopped on purpose; a new idea or a drain command starts it again. */
  readonly #held = new Set<string>();
  /** Where the event log was when a play opened: delivery events are searched from there. */
  readonly #marks = new Map<string, number>();

  constructor(options: IdeaQueueServiceOptions) {
    this.#options = options;
  }

  // ---- the queue ----

  async add(scenarioId: string, input: IdeaAddInput): Promise<IdeaRecord> {
    const { store } = this.#options;
    if ((await store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    const text = input.text.trim();
    if (text === '') throw new InvalidInput('The idea is empty');
    const area = input.area?.trim();
    const idea = await store.ideas.create({
      scenarioId,
      text,
      source: input.source ?? 'chat',
      ...(area === undefined || area === '' ? {} : { area }),
    });
    await this.#emit('idea.added', scenarioId, {
      ideaId: idea.id,
      scenarioId,
      source: idea.source,
      area: idea.area,
    });
    this.#held.delete(scenarioId);
    this.kick(scenarioId);
    return idea;
  }

  list(scenarioId: string): Promise<readonly IdeaRecord[]> {
    return this.#options.store.ideas.list({ scenarioId });
  }

  /** The Producer drops an idea for good, with the reason. */
  async discard(ideaId: string, reason: string): Promise<IdeaRecord> {
    const idea = await this.#ownIdea(ideaId);
    const why = reasonOf(reason);
    const updated = await this.#options.store.ideas.transition(ideaId, 'discarded', {
      reason: why,
    });
    await this.#emit('idea.discarded', idea.scenarioId, {
      ideaId,
      reason: why,
      by: 'producer',
    });
    return updated;
  }

  /** The Producer leaves an idea for later, with the reason. */
  async defer(ideaId: string, reason: string): Promise<IdeaRecord> {
    const idea = await this.#ownIdea(ideaId);
    const why = reasonOf(reason);
    const updated = await this.#options.store.ideas.transition(ideaId, 'deferred', {
      reason: why,
    });
    await this.#emit('idea.deferred', idea.scenarioId, { ideaId, reason: why, by: 'producer' });
    return updated;
  }

  /** A deferred idea goes back to the queue. */
  async requeue(ideaId: string): Promise<IdeaRecord> {
    const idea = await this.#ownIdea(ideaId);
    if (idea.state !== 'deferred') {
      throw new Conflict(`The idea ${ideaId} is ${idea.state}, not deferred`);
    }
    const updated = await this.#options.store.ideas.transition(ideaId, 'queued', {
      reason: 'taken out of the deferral by the Producer',
    });
    await this.#emit('idea.returned', idea.scenarioId, {
      ideaId,
      playId: null,
      reason: 'taken out of the deferral by the Producer',
    });
    this.#held.delete(idea.scenarioId);
    this.kick(idea.scenarioId);
    return updated;
  }

  async #ownIdea(ideaId: string): Promise<IdeaRecord> {
    const idea = await this.#options.store.ideas.get(ideaId);
    if (idea === undefined) throw new NotFound(`There is no idea "${ideaId}"`);
    return idea;
  }

  // ---- passes of the queue ----

  /**
   * Starts a pass of the queue in the background when `ideas.drain` is `auto`. Errors are logged:
   * nobody waits for it.
   */
  kick(scenarioId: string): void {
    const pass = this.#serial(scenarioId, async () => {
      if (this.#held.has(scenarioId)) return;
      const settings = await this.#settingsOf(scenarioId);
      if (settings === undefined || settings.drain !== 'auto') return;
      await this.#pass(scenarioId, settings);
    }).catch((error: unknown) => {
      this.#options.logger.error({ err: error, scenarioId }, 'the idea queue pass failed');
    });
    const tracked = pass.finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  /** `/idea drain`: one pass now, whatever `ideas.drain` says. */
  async drain(scenarioId: string): Promise<DrainResult> {
    if ((await this.#options.store.scenarios.get(scenarioId)) === undefined) {
      throw new NotFound(`There is no scenario "${scenarioId}"`);
    }
    return this.#serial(scenarioId, async () => {
      this.#held.delete(scenarioId);
      const settings = await this.#settingsOf(scenarioId);
      if (settings === undefined) return { groups: 0, stopped: 'the scenario is gone' };
      return this.#pass(scenarioId, settings);
    });
  }

  /** Resolves when the passes started in the background have ended (the tests, the shutdown). */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.all([...this.#background]);
  }

  #serial<T>(scenarioId: string, work: () => Promise<T>): Promise<T> {
    const before = this.#chains.get(scenarioId) ?? Promise.resolve();
    const next = before.then(work, work);
    const tail = next.catch(() => undefined);
    this.#chains.set(scenarioId, tail);
    void tail.then(() => {
      if (this.#chains.get(scenarioId) === tail) this.#chains.delete(scenarioId);
    });
    return next;
  }

  async #settingsOf(scenarioId: string): Promise<IdeaSettings | undefined> {
    const { store, config, logger } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) return undefined;
    const resolved = ideaSettingsOf(config.ideas, scenario.configOverride);
    for (const problem of resolved.problems) {
      logger.warn({ scenarioId, problem }, 'a key ideas.* of the scenario is not used');
    }
    return resolved.settings;
  }

  /** Groups while there is room (`ideas.parallel_plays`) and ideas in the queue. */
  async #pass(scenarioId: string, settings: IdeaSettings): Promise<DrainResult> {
    const { store } = this.#options;
    let groups = 0;
    for (let round = 0; round < MAX_GROUPINGS_PER_PASS; round += 1) {
      const all = await store.ideas.list({ scenarioId });
      const queued = all.filter((idea) => idea.state === 'queued');
      if (queued.length === 0) return { groups, stopped: undefined };
      const inFlight = new Set(
        all
          .filter((idea) => idea.state === 'grouped' && idea.groupId !== null)
          .map((i) => i.groupId),
      );
      if (inFlight.size >= settings.parallel_plays) {
        return { groups, stopped: 'ideas.parallel_plays groups are already in flight' };
      }
      const outcome = await this.#group(scenarioId, queued, settings);
      if (typeof outcome === 'string') {
        this.#held.add(scenarioId);
        return { groups, stopped: outcome };
      }
      if (outcome === 'grouped') groups += 1;
      else if (outcome === 'nothing') {
        // The Author left everything out: asking again would give the same answer.
        this.#held.add(scenarioId);
        return { groups, stopped: 'the Author left every idea out of the group' };
      }
    }
    return { groups, stopped: 'the pass reached its limit of groupings' };
  }

  /**
   * One grouping: runs the Author, applies what it dropped, postponed or split, and turns the
   * group into a decision or a play. A string is the reason the grouping could not be made.
   */
  async #group(
    scenarioId: string,
    queued: readonly IdeaRecord[],
    settings: IdeaSettings,
  ): Promise<'grouped' | 'nothing' | 'progress' | string> {
    const { store } = this.#options;
    const answer = await this.#runAuthor(scenarioId, queued, settings.max_per_play);
    if (typeof answer === 'string') return answer;
    for (const item of answer.discarded) {
      await store.ideas.transition(item.ideaId, 'discarded', { reason: item.reason });
      await this.#emit('idea.discarded', scenarioId, {
        ideaId: item.ideaId,
        reason: item.reason,
        by: 'author',
      });
    }
    for (const item of answer.deferred) {
      await store.ideas.transition(item.ideaId, 'deferred', { reason: item.reason });
      await this.#emit('idea.deferred', scenarioId, {
        ideaId: item.ideaId,
        reason: item.reason,
        by: 'author',
      });
    }
    let split = false;
    for (const item of answer.split) {
      await store.ideas.transition(item.ideaId, 'discarded', {
        reason: `split into ${String(item.parts.length)} ideas: ${item.reason}`,
      });
      await this.#emit('idea.discarded', scenarioId, {
        ideaId: item.ideaId,
        reason: `split into ${String(item.parts.length)} ideas: ${item.reason}`,
        by: 'author',
      });
      const original = queued.find((idea) => idea.id === item.ideaId);
      for (const part of item.parts) {
        const created = await store.ideas.create({
          scenarioId,
          text: part,
          source: 'author',
          ...(original?.area == null ? {} : { area: original.area }),
        });
        await this.#emit('idea.added', scenarioId, {
          ideaId: created.id,
          scenarioId,
          source: 'author',
          area: created.area,
        });
      }
      split = true;
    }
    const members = answer.group.ideaIds;
    if (members.length === 0) {
      return split || answer.discarded.length > 0 || answer.deferred.length > 0
        ? 'progress'
        : 'nothing';
    }

    const groupId = `grp-${randomUUID().slice(0, 8)}`;
    const need = answer.group.need;
    for (const [index, ideaId] of members.entries()) {
      await store.ideas.transition(ideaId, 'grouped', { groupId, groupOrder: index + 1 });
    }
    const awaiting = settings.grouping_approval === 'ask';
    await this.#emit('idea.grouped', scenarioId, {
      groupId,
      scenarioId,
      ideaIds: members,
      need,
      awaitingApproval: awaiting,
      leftOut: answer.leftOut.map((item) => ({
        ideaId: item.ideaId,
        reason: item.reason,
        ...(item.question === undefined ? {} : { question: item.question }),
      })),
    });
    if (!awaiting) {
      await this.#openGroup(scenarioId, groupId, need, 'auto');
      return 'grouped';
    }
    const ideas = await store.ideas.list({ scenarioId, groupId });
    await store.decisions.create({
      id: `${scenarioId}:ideas:${groupId}`,
      scenarioId,
      kind: IDEA_GROUP_DECISION,
      input: {
        groupId,
        need,
        rationale: answer.group.rationale,
        ideas: ideas.map((idea) => ({ id: idea.id, text: idea.text, area: idea.area })),
        leftOut: answer.leftOut.map((item) => ({
          ideaId: item.ideaId,
          reason: item.reason,
          ...(item.question === undefined ? {} : { question: item.question }),
        })),
      },
    });
    return 'grouped';
  }

  /** Runs the Author on the queue; the answer, or the reason there is none. */
  async #runAuthor(
    scenarioId: string,
    queued: readonly IdeaRecord[],
    maxPerPlay: number,
  ): Promise<IdeaGroupOutput | string> {
    const { store, vcs, runner, registries, prompts, config, paths } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) return 'the scenario is gone';
    const executor = executorOf(config, GROUPING_ROLE);
    if (executor === undefined) {
      return 'No Executor is configured for the author: set orchestration.executor or orchestration.roles.author.';
    }
    const repos = await store.scenarioRepos.list(scenarioId);
    const prefix = assemblePrefix({
      role: GROUPING_ROLE,
      rolePrompt: await prompts.get(GROUPING_ROLE),
      tools: registries.tools.list(),
    });
    const body = [
      `#ot-role: ${GROUPING_ROLE}`,
      `#ot-group-ideas: ${String(maxPerPlay)}`,
      ...queued.map((idea) => `- ${idea.id} [area: ${idea.area ?? '-'}] ${oneLine(idea.text)}`),
      '',
      'These are the ideas in the queue of the scenario (judgment point `group_ideas`).',
      `Group the ideas that belong in the next play, at most ${String(maxPerPlay)}, in the order they should be done.`,
      'Put every idea in exactly one list of the answer: the group, `leftOut`, `discarded`, `deferred` or `split`; always give the reason.',
      'Answer with `submit_idea_group`.',
    ].join('\n');
    const { profile, executor: settings } = sessionSettingsOf(paths, executor);
    const mark = await store.events.lastId();
    const outcome = await runner.run({
      playId: scenarioId,
      demandId: `ideas-${randomUUID().slice(0, 6)}`,
      attempt: 1,
      repo: repos[0]?.path ?? scenario.folder,
      base: repos[0]?.mainBranch ?? scenario.baseBranch ?? 'main',
      profile,
      executor: settings,
      policy: policyOf(GROUPING_ROLE),
      prompt: `${prefix}\n${body}`,
      role: GROUPING_ROLE,
    });
    await vcs.removeWorktree(outcome.worktree, { force: true }).catch(() => undefined);
    if (outcome.state !== 'completed') {
      return `The author session ${outcome.state}${outcome.cause === undefined ? '' : `: ${outcome.cause}`}.`;
    }
    const submitted = await submissionOf(store, outcome.attemptId, mark);
    if (submitted === undefined)
      return 'The author ended its turn without calling `submit_idea_group`.';
    if (typeof submitted === 'string') return submitted;
    const parsed = ideaGroupOutput.safeParse(submitted.output);
    if (!parsed.success) {
      return `The author's answer does not fit the schema: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`;
    }
    const problems = checkIdeaGroup(
      parsed.data,
      queued.map((idea) => idea.id),
      maxPerPlay,
    );
    if (problems.length > 0)
      return `The author's answer does not fit the queue: ${problems.join('; ')}`;
    return parsed.data;
  }

  // ---- from a group to a play ----

  /**
   * The Producer's answer to the group that waits (`ProducerChannel.answer`): approve it, edit it
   * (a new need, and/or fewer ideas, in the order given) and open the play, or refuse it, which
   * sends every idea back to the queue.
   */
  async answerGroup(decisionId: string, answer: GroupAnswer): Promise<JsonObject> {
    const { store } = this.#options;
    const decision = await store.decisions.get(decisionId);
    if (decision === undefined || decision.kind !== IDEA_GROUP_DECISION) {
      throw new NotFound(`There is no idea group "${decisionId}"`);
    }
    if (decision.state !== 'pending') {
      throw new Conflict(`The decision "${decisionId}" is already ${decision.state}`);
    }
    const { scenarioId } = decision;
    const groupId = String(decision.input.groupId);
    return this.#serial(scenarioId, async () => {
      const members = await store.ideas.list({ scenarioId, groupId });
      if (answer.option === 'refuse') {
        const given = answer.reason?.trim();
        const reason =
          given === undefined || given === '' ? 'the Producer refused the group' : given;
        await store.decisions.decide(decisionId, {
          answer: { option: 'refuse', reason },
          decidedBy: 'producer',
        });
        for (const idea of members) await this.#giveBack(idea, null, reason);
        this.#held.add(scenarioId);
        return { option: 'refuse', returned: members.map((idea) => idea.id) };
      }
      let need = String(decision.input.need);
      let kept = members;
      if (answer.option === 'edit') {
        if (answer.need === undefined && answer.ideaIds === undefined) {
          throw new InvalidInput('To edit the group, give a new need or the ideas that stay');
        }
        if (answer.need !== undefined) {
          if (answer.need.trim() === '') throw new InvalidInput('The need is empty');
          need = answer.need.trim();
        }
        if (answer.ideaIds !== undefined) {
          const byId = new Map(members.map((idea) => [idea.id, idea]));
          const chosen: IdeaRecord[] = [];
          for (const id of answer.ideaIds) {
            const idea = byId.get(id);
            if (idea === undefined) throw new InvalidInput(`The idea ${id} is not in the group`);
            if (chosen.includes(idea)) throw new InvalidInput(`The idea ${id} is repeated`);
            chosen.push(idea);
          }
          if (chosen.length === 0) {
            throw new InvalidInput('The group needs at least one idea; refuse it instead');
          }
          kept = chosen;
        }
      }
      await store.decisions.decide(decisionId, {
        answer: { ...answerJson(answer), need },
        decidedBy: 'producer',
      });
      for (const idea of members) {
        if (!kept.includes(idea)) {
          await this.#giveBack(idea, null, 'the Producer took it out of the group');
        }
      }
      for (const [index, idea] of kept.entries()) {
        await store.ideas.transition(idea.id, 'grouped', { groupOrder: index + 1 });
      }
      const result = await this.#openGroup(scenarioId, groupId, need, 'ask');
      return { option: answer.option, ...result };
    });
  }

  /** Opens the play of a group; when it cannot, the ideas go back to the queue. */
  async #openGroup(
    scenarioId: string,
    groupId: string,
    need: string,
    approval: 'ask' | 'auto',
  ): Promise<JsonObject> {
    const { store, opening, logger } = this.#options;
    const members = await store.ideas.list({ scenarioId, groupId });
    const mark = await store.events.lastId();
    let opened;
    try {
      opened = await openPlayFromNeed(opening, scenarioId, needOf(need, members));
    } catch (error) {
      logger.error({ err: error, scenarioId, groupId }, 'the play of the group did not open');
      const reason = error instanceof Error ? error.message : String(error);
      for (const idea of members)
        await this.#giveBack(idea, null, `the play did not open: ${reason}`);
      this.#held.add(scenarioId);
      return { returned: members.map((idea) => idea.id), reason };
    }
    if (!opened.ok) {
      for (const idea of members) await this.#giveBack(idea, null, opened.message);
      this.#held.add(scenarioId);
      return { returned: members.map((idea) => idea.id), reason: opened.message };
    }
    this.#marks.set(opened.playId, mark);
    for (const idea of members) {
      await store.ideas.transition(idea.id, 'grouped', { playId: opened.playId });
    }
    await this.#emit('idea.play_opened', scenarioId, {
      groupId,
      scenarioId,
      playId: opened.playId,
      ideaIds: members.map((idea) => idea.id),
      approval,
    });
    return { playId: opened.playId };
  }

  async #giveBack(idea: IdeaRecord, playId: string | null, reason: string): Promise<void> {
    await this.#options.store.ideas.transition(idea.id, 'queued', { reason });
    await this.#emit('idea.returned', idea.scenarioId, { ideaId: idea.id, playId, reason });
  }

  // ---- the end of a play ----

  /**
   * Told by the play runner that a play reached a final state. `DONE` with a delivery links the
   * ideas to the play and its PR; a play that was cancelled, or ended without delivery, gives them
   * back to the queue (and holds the queue, so the same ideas are not tried again at once).
   * Returns when the ideas are settled.
   */
  async onPlayFinished(play: PlayRecord): Promise<void> {
    await this.#serial(play.scenarioId, async () => {
      const { store } = this.#options;
      const members = (
        await store.ideas.list({ scenarioId: play.scenarioId, playId: play.id })
      ).filter((idea) => idea.state === 'grouped');
      if (members.length === 0) return;
      const delivery = play.state === 'DONE' ? await this.#deliveryOf(play.id) : undefined;
      if (delivery === undefined) {
        const reason =
          play.state === 'DONE'
            ? 'the play ended without delivering'
            : `the play ended ${play.state.toLowerCase()}`;
        for (const idea of members) await this.#giveBack(idea, play.id, reason);
        this.#held.add(play.scenarioId);
        return;
      }
      for (const idea of members) {
        await store.ideas.transition(idea.id, 'done', {
          playId: play.id,
          ...(delivery.pullRequest === undefined ? {} : { pullRequest: delivery.pullRequest }),
        });
        await this.#emit('idea.done', play.scenarioId, {
          ideaId: idea.id,
          playId: play.id,
          pullRequest: delivery.pullRequest ?? null,
        });
      }
      this.#marks.delete(play.id);
    });
    this.kick(play.scenarioId);
  }

  /** The delivery of a play: what `delivery.completed` says, or `undefined` when it did not happen. */
  async #deliveryOf(
    playId: string,
  ): Promise<{ pullRequest?: { number: number; url: string } } | undefined> {
    const { events } = this.#options.store;
    let after = this.#marks.get(playId) ?? 0;
    let found: { pullRequest?: { number: number; url: string } } | undefined;
    for (;;) {
      const page: readonly EventEnvelope[] = await events.readFrom(after, 500);
      if (page.length === 0) return found;
      for (const event of page) {
        after = event.id;
        if (event.type !== 'delivery.completed' || event.playId !== playId) continue;
        const pr = event.payload.pullRequest;
        found =
          typeof pr === 'object' && pr !== null && !Array.isArray(pr)
            ? { pullRequest: { number: Number(pr.number), url: String(pr.url) } }
            : {};
      }
    }
  }

  /**
   * At start-up: ideas whose group lost its decision or its play go back to the queue, the ones
   * of a play that already ended are settled, and the queues that can move start moving.
   */
  async settle(): Promise<void> {
    const { store, logger } = this.#options;
    const grouped = await store.ideas.list({ states: ['grouped'] });
    const scenarios = new Set<string>();
    const handled = new Set<string>();
    for (const idea of grouped) {
      scenarios.add(idea.scenarioId);
      if (idea.playId !== null) {
        if (handled.has(idea.playId)) continue;
        handled.add(idea.playId);
        const play = await store.plays.get(idea.playId);
        if (play?.finishedAt != null) await this.onPlayFinished(play);
        continue;
      }
      const pending = await store.decisions.list({
        scenarioId: idea.scenarioId,
        kinds: [IDEA_GROUP_DECISION],
        states: ['pending'],
      });
      if (pending.some((decision) => decision.input.groupId === idea.groupId)) continue;
      await this.#giveBack(idea, null, 'the group was lost in a restart').catch(
        (error: unknown) => {
          logger.warn(
            { err: error, ideaId: idea.id },
            'an idea of a lost group was not given back',
          );
        },
      );
    }
    for (const idea of await store.ideas.list({ states: ['queued'] }))
      scenarios.add(idea.scenarioId);
    for (const scenarioId of scenarios) this.kick(scenarioId);
  }

  async #emit<T extends DaemonEventType>(
    type: T,
    scenarioId: string,
    payload: DaemonEventPayloads[T],
  ): Promise<void> {
    await this.#options.store.events.append({ ...buildDaemonEvent(type, payload), scenarioId });
  }
}

function reasonOf(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new InvalidInput('Give the reason');
  return trimmed;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function answerJson(answer: GroupAnswer): JsonObject {
  if (answer.option !== 'edit') return { option: answer.option };
  return {
    option: 'edit',
    ...(answer.need === undefined ? {} : { need: answer.need }),
    ...(answer.ideaIds === undefined ? {} : { ideaIds: [...answer.ideaIds] }),
  };
}

/** The need of the play: the group's need, and the ideas it carries out, by id and in order. */
function needOf(need: string, members: readonly IdeaRecord[]): string {
  const ordered = [...members].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0));
  return [
    need,
    '',
    'Ideas of the queue this play carries out, in the order to do them:',
    ...ordered.map((idea) => `- ${idea.id}: ${oneLine(idea.text)}`),
  ].join('\n');
}

async function submissionOf(
  store: Pick<Store, 'events'>,
  attemptId: string,
  mark: number,
): Promise<{ output: unknown } | string | undefined> {
  let after = mark;
  let found: { output: unknown } | string | undefined;
  for (;;) {
    const page: readonly EventEnvelope[] = await store.events.readFrom(after, 500);
    if (page.length === 0) return found;
    for (const event of page) {
      after = event.id;
      const payload = event.payload as Record<string, unknown>;
      if (payload.attemptId !== attemptId) continue;
      if (event.type === 'attempt.submitted') found = { output: payload.output };
      else if (event.type === 'attempt.submit_failed') found = String(payload.errors);
    }
  }
}
