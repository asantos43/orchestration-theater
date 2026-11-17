// SPDX-License-Identifier: MPL-2.0
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JsonObject } from '@otheater/core';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from './commands.js';
import { dataPaths } from './paths.js';
import type { ChatPoll, PendingAsk } from './orchestration/channel.js';
import { ChannelClient, readChannelInfo } from './orchestration/channel-http.js';

/** How often `ot chat` asks the daemon what happened, in milliseconds. [proposta] */
export const CHAT_POLL_MS = 300;

export interface ChatOptions {
  /** The repository the Director works on. */
  readonly repo: string;
  readonly base?: string | undefined;
  readonly name?: string | undefined;
  /** What the Producer types: one message per line. */
  readonly input: NodeJS.ReadableStream;
  /** Aborting leaves the chat (the entry point wires Ctrl+C to it). */
  readonly signal?: AbortSignal | undefined;
  readonly pollMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    repo: options.repo,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.name === undefined ? {} : { name: options.name }),
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
  /** The ask the next line answers, with the answers of its questions so far. */
  let current: { ask: PendingAsk; collected: string[] } | undefined;
  const waiting: PendingAsk[] = [];
  const pollMs = options.pollMs ?? CHAT_POLL_MS;
  let quiet = 0;

  const show = (poll: ChatPoll): void => {
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
    if (ask.kind === 'producer_menu') {
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

  const handleLine = async (line: string): Promise<void> => {
    if (current === undefined) {
      if (line.trim() !== '') await client.send(scenarioId, line);
      return;
    }
    const { ask } = current;
    try {
      if (ask.kind === 'producer_menu') {
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
