// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JsonObject } from '@otheater/core';
import type { IdeaQueueHeldPayload, ScenarioSystemMessagePayload } from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from './commands.js';
import { dataPaths } from './paths.js';
import type {
  ChatPoll,
  IdeaCommand,
  IdeaCommandResult,
  IdeaView,
  PendingAsk,
  WaitView,
} from './orchestration/channel.js';
import { ChannelClient, readChannelInfo } from './orchestration/channel-http.js';

/** How often `ot chat` asks the daemon what happened, in milliseconds. [proposta] */
export const CHAT_POLL_MS = 300;

export interface ChatOptions {
  /** The type of scenario: `project` (default) or `chat`. */
  readonly type?: string | undefined;
  /** The repository the Director works on (a `project`). */
  readonly repo?: string | undefined;
  readonly base?: string | undefined;
  readonly name?: string | undefined;
  /** Create the project in `repo` with the structure of the `software` profile. */
  readonly newProject?: boolean | undefined;
  /** What the Producer types: one message per line. */
  readonly input: NodeJS.ReadableStream;
  /** Aborting leaves the chat (the entry point wires Ctrl+C to it). */
  readonly signal?: AbortSignal | undefined;
  readonly pollMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface Question {
  readonly question: string;
  readonly options: readonly { label: string; description: string }[];
}

function questionsOf(ask: PendingAsk): Question[] {
  const raw = ask.input.questions;
  if (!Array.isArray(raw)) return [];
  const questions: Question[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.question !== 'string') continue;
    const options: Question['options'][number][] = [];
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isRecord(option)) continue;
        options.push({
          label: textOf(option.label),
          description: textOf(option.description),
        });
      }
    }
    questions.push({ question: item.question, options });
  }
  return questions;
}

function menuOptionsOf(ask: PendingAsk): string[] {
  const raw = ask.input.options;
  return Array.isArray(raw)
    ? raw.filter((option): option is string => typeof option === 'string')
    : [];
}

/**
 * The lines of a system message of the daemon in the language of the Producer (5.22). [proposta]
 * The `recovery` kind: a title, then one line each for what was resumed, what the effect verifier
 * settled and what waits for the Producer; a line with nothing in it is left out.
 */
export function renderSystemMessage(t: TFunction, notice: ScenarioSystemMessagePayload): string[] {
  const lines = [t('chat.system.recovery.title')];
  const resumed = notice.resumed.map((item) =>
    t(
      item.kind === 'play' ? 'chat.system.recovery.item.play' : 'chat.system.recovery.item.attempt',
      { id: item.id },
    ),
  );
  const settled = notice.settled.map((item) =>
    t(
      item.outcome === 'done'
        ? 'chat.system.recovery.item.settledDone'
        : 'chat.system.recovery.item.settledNotDone',
      { effectType: item.effectType, playId: item.playId },
    ),
  );
  const waiting = notice.waiting.map((item) => {
    if (item.kind === 'effect') {
      return t('chat.system.recovery.item.waitingEffect', {
        effectType: item.effectType ?? '',
        playId: item.playId ?? '',
      });
    }
    return t('chat.system.recovery.item.waitingPlay', { id: item.id });
  });
  if (resumed.length > 0) {
    lines.push(t('chat.system.recovery.resumed', { items: resumed.join('; ') }));
  }
  if (settled.length > 0) {
    lines.push(t('chat.system.recovery.settled', { items: settled.join('; ') }));
  }
  if (waiting.length > 0) {
    lines.push(t('chat.system.recovery.waiting', { items: waiting.join('; ') }));
  }
  return lines;
}

/** The kind of the ask of a group of ideas (`ideas/service.ts`; not imported, the chat is lean). */
const IDEA_GROUP_KIND = 'ideas.group';

/** The command `/idea ...` as the channel takes it; `undefined` when the line does not fit. */
export function parseIdeaCommand(line: string): IdeaCommand | undefined {
  const rest = line.trim().replace(/^\/idea\s*/, '');
  const [word = '', ...words] = rest.split(/\s+/);
  switch (word) {
    // `list` and `drain` alone are commands; with more words they are the start of an idea.
    case 'list':
      if (words.length === 0) return { action: 'list' };
      break;
    case 'drain':
      if (words.length === 0) return { action: 'drain' };
      break;
    case 'requeue':
      return words.length === 1 && words[0] !== undefined
        ? { action: 'requeue', id: words[0] }
        : undefined;
    case 'discard':
    case 'defer': {
      const [id, ...reason] = words;
      if (id === undefined || reason.length === 0) return undefined;
      return { action: word, id, reason: reason.join(' ') };
    }
    default:
  }
  // Anything else is the text of an idea; `add` says so when the text starts with a word above.
  let body = word === 'add' ? words.join(' ') : rest;
  let area: string | undefined;
  const flagged = /^--area[=\s]+(\S+)\s*(.*)$/s.exec(body);
  if (flagged !== null) {
    area = flagged[1];
    body = flagged[2] ?? '';
  }
  body = body.trim();
  if (body === '') return undefined;
  return { action: 'add', text: body, ...(area === undefined ? {} : { area }) };
}

/** What the Producer is told when the idea queue stops: why, and what frees it. */
export function renderQueueHeld(t: TFunction, held: IdeaQueueHeldPayload): string[] {
  return t('chat.ideaHeld', {
    what: t(`chat.ideaHeldWhat_${held.cause}`, { playId: held.playId ?? '' }),
    reason: held.reason,
  }).split('\n');
}

/**
 * What a demand that waits for an Executor says (P16): "esperando cota de claude-code/a, claude-code/b
 * (actor, d1)", one line for each cause (quota, spending cap, slot, RAM, health).
 */
export function renderWait(t: TFunction, wait: WaitView): string[] {
  const causes = new Map<string, string[]>();
  for (const item of wait.on) {
    const profiles = causes.get(item.reason) ?? [];
    if (!profiles.includes(item.profile)) profiles.push(item.profile);
    causes.set(item.reason, profiles);
  }
  const who = wait.demandId === null ? wait.role : `${wait.role}, ${wait.demandId}`;
  return [...causes].map(([reason, profiles]) =>
    t('chat.waiting', {
      what: t(`chat.waitingFor_${reason}`, { profiles: profiles.join(', ') }),
      who,
    }),
  );
}

function ideaLine(t: TFunction, idea: IdeaView): string {
  const links = [
    idea.playId === null ? '' : ` (${idea.playId}`,
    idea.playId !== null && idea.prNumber !== null ? ` PR #${String(idea.prNumber)}` : '',
    idea.playId === null ? '' : ')',
    idea.reason !== null && (idea.state === 'discarded' || idea.state === 'deferred')
      ? ` - ${idea.reason}`
      : '',
  ].join('');
  return t('chat.ideaLine', {
    id: idea.id,
    state: idea.state,
    area: idea.area === null ? '' : ` {${idea.area}}`,
    text: idea.text,
    links,
  });
}

/** What `/idea` prints. */
export function renderIdeaResult(
  t: TFunction,
  command: IdeaCommand,
  result: IdeaCommandResult,
): string[] {
  const lines: string[] = [];
  if (command.action === 'add' && result.idea !== undefined) {
    lines.push(t('chat.ideaAdded', { id: result.idea.id }));
  } else if (command.action === 'drain' && result.drain !== undefined) {
    lines.push(t('chat.ideaDrained', { groups: result.drain.groups }));
    if (result.drain.stopped !== undefined) {
      lines.push(t('chat.ideaDrainStopped', { reason: result.drain.stopped }));
    }
  } else if (result.idea !== undefined && command.action !== 'list') {
    lines.push(t('chat.ideaSettled', { id: result.idea.id, state: result.idea.state }));
  }
  if (command.action === 'list') {
    if (result.ideas.length === 0) lines.push(t('chat.ideaEmpty'));
    for (const idea of result.ideas) lines.push(ideaLine(t, idea));
  }
  return lines;
}

/** The group of ideas that waits for the Producer: what the Author put together, and what it left. */
export function renderIdeaGroup(t: TFunction, ask: PendingAsk): string[] {
  const ideas = recordsOf(ask.input.ideas);
  const leftOut = recordsOf(ask.input.leftOut);
  return [
    t('chat.ideaGroup', {
      count: ideas.length,
      need: textOf(ask.input.need),
      rationale: textOf(ask.input.rationale),
    }),
    ...ideas.map((item) =>
      t('chat.ideaGroupItem', { id: textOf(item.id), text: textOf(item.text) }),
    ),
    ...leftOut.map((item) =>
      t('chat.ideaGroupLeftOut', {
        id: textOf(item.ideaId),
        reason: textOf(item.reason),
        question: textOf(item.question) === '' ? '' : ` - ${textOf(item.question)}`,
      }),
    ),
    t('chat.ideaGroupOptions'),
  ];
}

/**
 * `ot chat` (decision N78, the minimal chat of the terminal): opens the scenario of a repository
 * on the running daemon, sends each line the Producer types to the single queue, shows what the
 * Director says and how the plays move, and takes the Producer's answers to the Director's
 * questions and to the menu of a play that ran out of a counter. [proposta] Ends when the input
 * ends and the daemon has nothing more going on; a question or a menu still open stays in the
 * daemon for the next `ot chat`.
 */
export async function runChatCommand(
  context: CommandContext,
  options: ChatOptions,
): Promise<number> {
  const { t, out, err } = context;
  const info = await readChannelInfo(dataPaths(context.dataDir).channel);
  if (info === undefined) {
    err(t('chat.noDaemon'));
    return EXIT_FAILED;
  }
  const client = new ChannelClient(info);
  const opened = await client.open({
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.newProject === true ? { newProject: true } : {}),
  });
  const { scenarioId } = opened;
  let cursor = opened.cursor;
  out(t('chat.opened', { scenarioId }));

  // Lines wait here until the loop below takes them one at a time.
  const lines: string[] = [];
  let ended = false as boolean;
  let wake: (() => void) | undefined;
  const reader = createInterface({ input: options.input, crlfDelay: Infinity });
  reader.on('line', (line) => {
    lines.push(line);
    wake?.();
  });
  reader.on('close', () => {
    ended = true;
    wake?.();
  });

  const shown = new Set<string>();
  const states = new Map<string, string>();
  const waitSaid = new Map<string, string>();
  /** The ask the next line answers, with the answers of its questions so far. */
  let current: { ask: PendingAsk; collected: string[] } | undefined;
  const waiting: PendingAsk[] = [];
  const pollMs = options.pollMs ?? CHAT_POLL_MS;
  let quiet = 0;

  const show = (poll: ChatPoll): void => {
    for (const notice of poll.notices) {
      for (const line of renderSystemMessage(t, notice)) out(line);
    }
    for (const held of poll.queueHolds) {
      for (const line of renderQueueHeld(t, held)) out(line);
    }
    // What waits for an Executor is said when it begins and again when its cause changes.
    const waitNow = new Map<string, string>();
    for (const wait of poll.waits) {
      const key = `${wait.playId ?? ''}/${wait.demandId ?? wait.role}`;
      const lines = renderWait(t, wait);
      waitNow.set(key, lines.join('\n'));
      if (waitSaid.get(key) !== waitNow.get(key)) for (const line of lines) out(line);
    }
    waitSaid.clear();
    for (const [key, text] of waitNow) waitSaid.set(key, text);
    for (const reply of poll.replies) {
      out(t('chat.reply', { text: reply.text }));
      cursor = Math.max(cursor, reply.seq);
    }
    const open = new Set<string>();
    for (const play of poll.plays) {
      open.add(play.id);
      if (states.get(play.id) !== play.state) {
        states.set(play.id, play.state);
        out(t('chat.play', { id: play.id, state: play.state }));
      }
    }
    for (const id of [...states.keys()]) {
      if (open.has(id)) continue;
      states.delete(id);
      out(t('chat.playEnded', { id }));
    }
    for (const ask of poll.asks) {
      if (shown.has(ask.id)) continue;
      shown.add(ask.id);
      waiting.push(ask);
    }
    // An ask that is gone (answered somewhere else, or nobody waits for it) is not waited on.
    const live = new Set(poll.asks.map((ask) => ask.id));
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      if (!live.has(waiting[index]?.id ?? '')) waiting.splice(index, 1);
    }
    if (current !== undefined && !live.has(current.ask.id)) current = undefined;
  };

  /** Takes the next ask that waits and says what it is, when nothing is being answered. */
  const activate = (): void => {
    if (current !== undefined) return;
    const ask = waiting.shift();
    if (ask === undefined) return;
    current = { ask, collected: [] };
    if (ask.kind === IDEA_GROUP_KIND) {
      for (const line of renderIdeaGroup(t, ask)) out(line);
    } else if (ask.kind !== 'producer_question') {
      out(
        t('chat.menu', {
          playId: ask.playId ?? '',
          reason: textOf(ask.input.reason),
          options: menuOptionsOf(ask).join(', '),
        }),
      );
    } else {
      promptQuestion(ask, 0);
    }
  };

  const promptQuestion = (ask: PendingAsk, index: number): void => {
    const question = questionsOf(ask)[index];
    if (question === undefined) return;
    out(t('chat.question', { question: question.question }));
    for (const option of question.options) {
      out(t('chat.option', { label: option.label, description: option.description }));
    }
  };

  const answerMenu = async (ask: PendingAsk, line: string): Promise<boolean> => {
    const [option = '', ...rest] = line.trim().split(/\s+/);
    if (!menuOptionsOf(ask).includes(option)) {
      out(t('chat.badOption', { options: menuOptionsOf(ask).join(', ') }));
      return false;
    }
    const text = rest.join(' ');
    const answer: JsonObject = {
      option,
      ...(text === '' ? {} : option === 'redefine_need' ? { need: text } : { reason: text }),
    };
    await client.answer(ask.id, answer);
    return true;
  };

  const answerGroup = async (ask: PendingAsk, line: string): Promise<boolean> => {
    const [option = '', ...rest] = line.trim().split(/\s+/);
    const text = rest.join(' ');
    let answer: JsonObject;
    if (option === 'approve') answer = { option };
    else if (option === 'refuse') answer = { option, ...(text === '' ? {} : { reason: text }) };
    else if (option === 'edit' && text !== '') answer = { option, need: text };
    else if (option === 'keep' && rest.length > 0) {
      answer = { option: 'edit', ideaIds: rest.flatMap((word) => word.split(',')).filter(Boolean) };
    } else {
      out(t('chat.ideaGroupBad'));
      return false;
    }
    await client.answer(ask.id, answer);
    return true;
  };

  const idea = async (line: string): Promise<void> => {
    const command = parseIdeaCommand(line);
    if (command === undefined) {
      err(t('chat.ideaUsage'));
      return;
    }
    try {
      const result = await client.idea(scenarioId, command);
      for (const text of renderIdeaResult(t, command, result)) out(text);
    } catch (error) {
      err(
        t('chat.ideaFailed', { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  /** The attachments made with `/attach` that the next message carries. */
  const attached: string[] = [];
  const attach = async (line: string): Promise<void> => {
    const [, ...words] = line.trim().split(/\s+/);
    const reference = words[0] === '--ref';
    const path = (reference ? words.slice(1) : words).join(' ');
    if (path === '') {
      err(t('chat.attachUsage'));
      return;
    }
    try {
      const record = await client.attach(scenarioId, {
        path: resolve(path),
        ...(reference ? { mode: 'reference' as const } : {}),
      });
      attached.push(record.id);
      out(t('chat.attached', record));
    } catch (error) {
      err(
        t('chat.attachFailed', { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    if (/^\/idea(\s|$)/.test(line)) {
      await idea(line);
      return;
    }
    if (current === undefined) {
      if (/^\/attach(\s|$)/.test(line)) {
        await attach(line);
        return;
      }
      if (line.trim() !== '') await client.send(scenarioId, line, attached.splice(0));
      return;
    }
    const { ask } = current;
    try {
      if (ask.kind === IDEA_GROUP_KIND) {
        if (await answerGroup(ask, line)) current = undefined;
        return;
      }
      if (ask.kind !== 'producer_question') {
        if (await answerMenu(ask, line)) current = undefined;
        return;
      }
      current.collected.push(line);
      const total = Math.max(questionsOf(ask).length, 1);
      if (current.collected.length < total) {
        promptQuestion(ask, current.collected.length);
        return;
      }
      const answers = current.collected;
      current = undefined;
      await client.answer(ask.id, { answers });
    } catch (error) {
      current = undefined;
      err(
        t('chat.answerFailed', { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  try {
    for (;;) {
      if (options.signal?.aborted === true) break;
      const poll = await client.poll(scenarioId, cursor);
      show(poll);
      activate();
      let acted = false;
      while (lines.length > 0) {
        await handleLine(lines.shift() ?? '');
        activate();
        acted = true;
      }
      const open = current !== undefined || waiting.length > 0;
      // What the poll said is out of date once a line was sent: wait for a poll after it.
      quiet = acted || (poll.busy && !open) ? 0 : quiet + 1;
      if (ended && quiet >= 2) break;
      await Promise.race([
        sleep(
          pollMs,
          undefined,
          options.signal === undefined ? {} : { signal: options.signal },
        ).catch(() => undefined),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = undefined;
    }
    if (current !== undefined || waiting.length > 0) err(t('chat.leftPending'));
  } finally {
    reader.close();
  }
  return EXIT_OK;
}
