// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ApiNetworkError,
  ApiRequestError,
  DaemonDirectoryError,
  type ApiClient,
  type ConnectedDaemon,
  type ReconnectOptions,
} from '@otheater/client';
import { createNodeDaemonDirectory } from '@otheater/client/node';
import type { JsonObject } from '@otheater/core';
import {
  API_ROUTES,
  IDEMPOTENCY_KEY_HEADER,
  type ChatServerMessage,
  type IdeaQueueHeldPayload,
  type ScenarioDirectorFailoverNotice,
  type ScenarioHandoffNotice,
  type ScenarioResetWaitNotice,
  type ScenarioSelectionWaitNotice,
  type ScenarioRecoveryNotice,
  type ScenarioSystemMessagePayload,
} from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from './commands.js';
import {
  ideaViewOf,
  type IdeaCommand,
  type IdeaCommandResult,
  type IdeaView,
  type PendingAsk,
  type WaitView,
} from './orchestration/channel.js';

/**
 * How long `ot chat` waits with nothing happening before it takes the end of the input as the end
 * of the chat, in milliseconds. The daemon pushes `busy` at most every `api.chat.state_interval`
 * (1 s by default), so the window is longer than that. [proposta]
 */
export const CHAT_QUIET_MS = 1500;

/** Failures in a row after which `ot chat` gives up on a daemon that does not come back. [proposta] */
export const CHAT_MAX_RETRIES = 5;

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
  /** Quiet window before the end of the input ends the chat. Default {@link CHAT_QUIET_MS}. */
  readonly quietMs?: number | undefined;
  /** How the chat socket tries again (backoff, limit). Default: the client's, with {@link CHAT_MAX_RETRIES}. */
  readonly reconnect?: ReconnectOptions | undefined;
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
  if (notice.kind === 'handoff') return renderHandoffMessage(t, notice);
  if (notice.kind === 'selection_wait') return renderSelectionWaitMessage(t, notice);
  if (notice.kind === 'reset_wait') return renderResetWaitMessage(t, notice);
  if (notice.kind === 'director_failover') return renderDirectorFailoverMessage(t, notice);
  return renderRecoveryMessage(t, notice);
}

/**
 * The `selection_wait` kind (P16b, N135, [proposta]): one line that says a role waits for an
 * Executor the strict cross-review keeps out (`wait_notify`), and what it waits on.
 */
function renderSelectionWaitMessage(t: TFunction, notice: ScenarioSelectionWaitNotice): string[] {
  return [
    t('chat.system.selectionWait', {
      role: notice.role,
      what: notice.crossCheck === 'other_model' ? 'model' : 'provider',
      crossCheck: notice.crossCheck,
      on:
        notice.on.length === 0
          ? '-'
          : notice.on.map((item) => `${item.executor} (${item.reason})`).join(', '),
    }),
  ];
}

/**
 * The `reset_wait` kind (Phase 5, P19, [proposta]): one line that says an Executor waits for its
 * quota or its spending cap to come back, and until when when a source says.
 */
function renderResetWaitMessage(t: TFunction, notice: ScenarioResetWaitNotice): string[] {
  return [
    t(notice.resetsAt === null ? 'chat.system.resetWaitNoDate' : 'chat.system.resetWait', {
      attemptId: notice.attemptId,
      executor: notice.executor,
      what: t(
        notice.cause === 'spend_cap'
          ? 'chat.system.resetWaitWhat.cap'
          : 'chat.system.resetWaitWhat.quota',
      ),
      until: notice.resetsAt === null ? '' : new Date(notice.resetsAt).toISOString(),
    }),
  ];
}

/**
 * The `director_failover` kind (Phase 5, P20, [proposta]): one line that says the session of the
 * Director failed, why, and what became of it (a new session, a wait or nothing).
 */
function renderDirectorFailoverMessage(
  t: TFunction,
  notice: ScenarioDirectorFailoverNotice,
): string[] {
  return [
    t(`chat.system.directorFailover.${notice.outcome}`, {
      from: notice.fromExecutor ?? '-',
      to: notice.toExecutor ?? '-',
      cause: notice.cause,
      until: notice.resetsAt === null ? '' : ` (${new Date(notice.resetsAt).toISOString()})`,
    }),
  ];
}

/**
 * The `handoff` kind (Phase 5, P18, [proposta]): one line that says which Executor passed the baton
 * to which one, and why.
 */
function renderHandoffMessage(t: TFunction, notice: ScenarioHandoffNotice): string[] {
  return [
    t('chat.system.handoff', {
      attemptId: notice.attemptId,
      cause: notice.cause,
      from: notice.fromExecutor,
      to: notice.toExecutor,
    }),
  ];
}

function renderRecoveryMessage(t: TFunction, notice: ScenarioRecoveryNotice): string[] {
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

/** The states in which a play is over (`pipeline/machine.ts`: the two `final` states). */
const FINAL_PLAY_STATES: ReadonlySet<string> = new Set(['DONE', 'CANCELLED']);

/** The text of an error of the client: what the daemon said, without the route and the status. */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message.replace(/^[^:]*: \w+ \(HTTP \d+\): /, '');
  }
  return error instanceof Error ? error.message : String(error);
}

/** The header that makes a command safe to repeat: one fresh key for each command. */
function commandHeaders(): { readonly [IDEMPOTENCY_KEY_HEADER]: string } {
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

/** `/idea` over REST: the same commands and the same result the old channel gave. */
async function runIdeaCommand(
  client: ApiClient,
  scenarioId: string,
  command: IdeaCommand,
): Promise<IdeaCommandResult> {
  const headers = commandHeaders();
  switch (command.action) {
    case 'add': {
      const { idea } = await client.call(API_ROUTES.addIdea, {
        params: { scenarioId },
        body: { text: command.text, ...(command.area === undefined ? {} : { area: command.area }) },
        headers,
      });
      return { idea: ideaViewOf(idea), ideas: [] };
    }
    case 'list': {
      const ideas: IdeaView[] = [];
      let after: string | undefined;
      do {
        const page = await client.call(API_ROUTES.listIdeas, {
          query: { scenarioId, limit: 200, ...(after === undefined ? {} : { after }) },
        });
        ideas.push(...page.items.map(ideaViewOf));
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      return { ideas };
    }
    case 'drain': {
      const { groups, stopped } = await client.call(API_ROUTES.drainIdeas, {
        params: { scenarioId },
        headers,
      });
      return { ideas: [], drain: { groups, stopped: stopped ?? undefined } };
    }
    case 'discard':
    case 'defer': {
      const route = command.action === 'discard' ? API_ROUTES.discardIdea : API_ROUTES.deferIdea;
      const { idea } = await client.call(route, {
        params: { ideaId: command.id },
        body: { reason: command.reason },
        headers,
      });
      return { idea: ideaViewOf(idea), ideas: [] };
    }
    case 'requeue': {
      const { idea } = await client.call(API_ROUTES.requeueIdea, {
        params: { ideaId: command.id },
        headers,
      });
      return { idea: ideaViewOf(idea), ideas: [] };
    }
  }
}

/** Connects to the daemon of the data folder, or says why not (and returns `undefined`). */
async function connectLocal(
  context: CommandContext,
  signal: AbortSignal | undefined,
): Promise<ConnectedDaemon | undefined> {
  const { t, err } = context;
  try {
    return await createNodeDaemonDirectory({ dataDir: context.dataDir }).connect(
      'local',
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (
      (error instanceof DaemonDirectoryError && error.code === 'not_found') ||
      error instanceof ApiNetworkError
    ) {
      err(t('chat.noDaemon'));
    } else {
      err(t('chat.connectFailed', { message: errorText(error) }));
    }
    return undefined;
  }
}

/**
 * `ot chat` (decision N78, the minimal chat of the terminal), over the API of the daemon (P8 of
 * the plan docs/17): finds the daemon by `api.json`, opens the scenario of a repository by REST,
 * and talks on the chat WebSocket, with a new ticket for each connection. It sends each line the
 * Producer types to the single queue, shows what the Director says and how the plays move, and
 * takes the Producer's answers to the Director's questions and to the menu of a play that ran out
 * of a counter. Attachments and `/idea` go by REST. [proposta] Ends when the input ends and the
 * daemon says it is not busy (`busy`) and has said nothing for a quiet window; a question or a
 * menu still open stays in the daemon for the next `ot chat`.
 */
export async function runChatCommand(
  context: CommandContext,
  options: ChatOptions,
): Promise<number> {
  const { t, out, err } = context;
  const connected = await connectLocal(context, options.signal);
  if (connected === undefined) return EXIT_FAILED;
  const { client } = connected;
  const opened = await client.call(API_ROUTES.openScenario, {
    body: {
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.newProject === true ? { newProject: true } : {}),
    },
    headers: commandHeaders(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const scenarioId = opened.scenario.id;
  out(t('chat.opened', { scenarioId }));

  // Lines wait here until the loop below takes them one at a time.
  const lines: string[] = [];
  let ended = false as boolean;
  let wake: (() => void) | undefined;
  const poke = (): void => {
    wake?.();
  };
  const reader = createInterface({ input: options.input, crlfDelay: Infinity });
  reader.on('line', (line) => {
    lines.push(line);
    poke();
  });
  reader.on('close', () => {
    ended = true;
    poke();
  });
  options.signal?.addEventListener('abort', poke, { once: true });

  const quietMs = options.quietMs ?? CHAT_QUIET_MS;
  /** When something last happened that the end of the chat has to wait for. */
  let activeAt = Date.now();
  const touch = (): void => {
    activeAt = Date.now();
  };

  const shown = new Set<string>();
  const states = new Map<string, string>();
  const finished = new Set<string>();
  const waitSaid = new Map<string, string>();
  const replyParts = new Map<number, string>();
  /** What the daemon last said about whether it is busy; unknown until it says. */
  let busy: boolean | undefined;
  /** The ask the next line answers, with the answers of its questions so far. */
  let current: { ask: PendingAsk; collected: string[] } | undefined;
  const waiting: PendingAsk[] = [];
  /** What the last message sent to the socket was: a refusal that comes back is about it. */
  let lastSent: 'message' | 'answer' = 'message';
  let failed = false as boolean;

  const showPlay = (id: string, state: string): void => {
    if (FINAL_PLAY_STATES.has(state)) {
      states.delete(id);
      if (finished.has(id)) return;
      finished.add(id);
      out(t('chat.playEnded', { id }));
      return;
    }
    if (finished.has(id) || states.get(id) === state) return;
    states.set(id, state);
    out(t('chat.play', { id, state }));
  };

  const onMessage = (message: ChatServerMessage): void => {
    touch();
    poke();
    switch (message.type) {
      case 'director_reply': {
        const text = `${replyParts.get(message.replyId) ?? ''}${message.text}`;
        if (message.final) {
          replyParts.delete(message.replyId);
          out(t('chat.reply', { text }));
        } else {
          replyParts.set(message.replyId, text);
        }
        return;
      }
      case 'ask':
        if (shown.has(message.decisionId)) return;
        shown.add(message.decisionId);
        waiting.push({
          id: message.decisionId,
          kind: message.kind,
          playId: message.playId,
          input: message.input,
        });
        activate();
        return;
      case 'system':
        for (const line of renderSystemMessage(t, message.message)) out(line);
        return;
      case 'queue_held':
        for (const line of renderQueueHeld(t, message.held)) out(line);
        return;
      case 'play_state':
        showPlay(message.playId, message.state);
        return;
      case 'waits': {
        // What waits for an Executor is said when it begins and again when its cause changes.
        const waitNow = new Map<string, string>();
        for (const wait of message.waits) {
          const key = `${wait.playId ?? ''}/${wait.demandId ?? wait.role}`;
          const text = renderWait(t, wait);
          waitNow.set(key, text.join('\n'));
          if (waitSaid.get(key) !== waitNow.get(key)) for (const line of text) out(line);
        }
        waitSaid.clear();
        for (const [key, text] of waitNow) waitSaid.set(key, text);
        return;
      }
      case 'busy':
        busy = message.busy;
        return;
      case 'error':
        err(
          t(lastSent === 'answer' ? 'chat.answerFailed' : 'chat.sendFailed', {
            message: message.error.message,
          }),
        );
        return;
    }
  };

  /** Plays that were already going when the chat opened: say them once, unless the socket did. */
  const seedPlays = async (): Promise<void> => {
    try {
      const page = await client.call(API_ROUTES.listScenarioPlays, {
        params: { scenarioId },
        query: { open: 'true', limit: 200 },
      });
      for (const play of page.items) {
        if (!states.has(play.id) && !finished.has(play.id)) showPlay(play.id, play.state);
      }
    } catch {
      // The socket tells every change from here on; the plays already going are only a courtesy.
    }
  };

  // A new ticket and a `resume` come with each connection and reconnection: the socket does both.
  const socket = client.chat(scenarioId, {
    ...options.reconnect,
    maxRetries: options.reconnect?.maxRetries ?? CHAT_MAX_RETRIES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const openWaiters: (() => void)[] = [];
  let seeded = false;
  socket.onMessage(onMessage);
  socket.onState((state, detail) => {
    if (state === 'open') {
      for (const resolveWaiter of openWaiters.splice(0)) resolveWaiter();
      if (!seeded) {
        seeded = true;
        void seedPlays();
      }
    } else if (state === 'retrying') {
      err(
        t('chat.reconnecting', {
          message: detail.error === undefined ? '' : errorText(detail.error),
          seconds: Math.ceil((detail.delayMs ?? 0) / 1000),
        }),
      );
    } else if (state === 'closed') {
      if (detail.error !== undefined) {
        failed = true;
        err(t('chat.connectionLost', { message: errorText(detail.error) }));
      }
      for (const resolveWaiter of openWaiters.splice(0)) resolveWaiter();
      poke();
    }
  });

  /** Resolves when the socket is open (or closed for good: the caller checks). */
  const untilOpen = (): Promise<void> =>
    socket.state === 'open' || socket.state === 'closed'
      ? Promise.resolve()
      : new Promise<void>((resolveOpen) => {
          openWaiters.push(resolveOpen);
        });

  /** Sends a message of the chat when the socket is open; says so when it cannot. */
  const sendOnSocket = async (
    message: Parameters<typeof socket.send>[0],
    failure: 'chat.answerFailed' | 'chat.sendFailed',
  ): Promise<boolean> => {
    await untilOpen();
    try {
      lastSent = message.type === 'answer' ? 'answer' : 'message';
      socket.send(message);
      return true;
    } catch (error) {
      err(t(failure, { message: errorText(error) }));
      return false;
    }
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

  const answer = (ask: PendingAsk, body: JsonObject): Promise<boolean> =>
    sendOnSocket({ type: 'answer', decisionId: ask.id, answer: body }, 'chat.answerFailed');

  const answerMenu = async (ask: PendingAsk, line: string): Promise<boolean> => {
    const [option = '', ...rest] = line.trim().split(/\s+/);
    if (!menuOptionsOf(ask).includes(option)) {
      out(t('chat.badOption', { options: menuOptionsOf(ask).join(', ') }));
      return false;
    }
    const text = rest.join(' ');
    await answer(ask, {
      option,
      ...(text === '' ? {} : option === 'redefine_need' ? { need: text } : { reason: text }),
    });
    return true;
  };

  const answerGroup = async (ask: PendingAsk, line: string): Promise<boolean> => {
    const [option = '', ...rest] = line.trim().split(/\s+/);
    const text = rest.join(' ');
    let body: JsonObject;
    if (option === 'approve') body = { option };
    else if (option === 'refuse') body = { option, ...(text === '' ? {} : { reason: text }) };
    else if (option === 'edit' && text !== '') body = { option, need: text };
    else if (option === 'keep' && rest.length > 0) {
      body = { option: 'edit', ideaIds: rest.flatMap((word) => word.split(',')).filter(Boolean) };
    } else {
      out(t('chat.ideaGroupBad'));
      return false;
    }
    await answer(ask, body);
    return true;
  };

  const idea = async (line: string): Promise<void> => {
    const command = parseIdeaCommand(line);
    if (command === undefined) {
      err(t('chat.ideaUsage'));
      return;
    }
    try {
      const result = await runIdeaCommand(client, scenarioId, command);
      for (const text of renderIdeaResult(t, command, result)) out(text);
    } catch (error) {
      err(t('chat.ideaFailed', { message: errorText(error) }));
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
      const record = await client.call(API_ROUTES.addAttachment, {
        params: { scenarioId },
        body: { path: resolve(path), ...(reference ? { mode: 'reference' as const } : {}) },
        headers: commandHeaders(),
      });
      attached.push(record.id);
      out(t('chat.attached', record));
    } catch (error) {
      err(t('chat.attachFailed', { message: errorText(error) }));
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
      if (line.trim() !== '') {
        const ids = attached.splice(0);
        await sendOnSocket(
          { type: 'message', text: line, ...(ids.length === 0 ? {} : { attachments: ids }) },
          'chat.sendFailed',
        );
      }
      return;
    }
    const { ask } = current;
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
    await answer(ask, { answers });
  };

  socket.start();
  try {
    for (;;) {
      if (options.signal?.aborted === true || failed) break;
      activate();
      let acted = false;
      while (lines.length > 0) {
        await handleLine(lines.shift() ?? '');
        activate();
        acted = true;
      }
      const open = current !== undefined || waiting.length > 0;
      // What the daemon said before a line was sent is out of date: the quiet window starts anew.
      if (acted || (busy === true && !open)) touch();
      const settled = ended && lines.length === 0 && busy === false;
      const remaining = quietMs - (Date.now() - activeAt);
      if (settled && remaining <= 0) break;
      await new Promise<void>((resolveWait) => {
        const timer = settled ? setTimeout(resolveWait, remaining) : undefined;
        wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
      wake = undefined;
    }
    if (current !== undefined || waiting.length > 0) err(t('chat.leftPending'));
  } finally {
    socket.close();
    reader.close();
  }
  return failed ? EXIT_FAILED : EXIT_OK;
}
