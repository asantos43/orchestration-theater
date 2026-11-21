// SPDX-License-Identifier: MPL-2.0
import type { ConnectionState } from '@otheater/client';
import type {
  ApiErrorBody,
  ChatServerMessage,
  ChatToolCall,
  ChatWait,
  IdeaQueueHeldPayload,
  ScenarioSystemMessagePayload,
  ShellCommandFinishedPayload,
  ShellCommandStartedPayload,
  SlashCommandResult,
} from '@otheater/protocol';

/**
 * The state of the chat of one scenario, as a pure reducer (P12 of docs/18): what the frames of the
 * `ChatSocket` and what the Producer does become. The session (`session.ts`) feeds it and the view
 * reads it. The rules that keep a drop of the socket from losing or repeating text live here:
 * - a reply is joined by its `replyId`, and a frame whose `eventId` is not past the last one
 *   applied to that reply is a repeat, which is dropped;
 * - the frames that stand for an event of the log (`system`, `queue_held`, `play_state`, the shell
 *   ones) are applied once: only a frame past the last one applied counts;
 * - an `ask` is kept once per `decisionId`, and one that was closed does not come back.
 */

export type EntryBody =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'generated';
      readonly tools: readonly ChatToolCall[];
      readonly playId: string | undefined;
    }
  | { readonly kind: 'system'; readonly notice: ScenarioSystemMessagePayload }
  | { readonly kind: 'held'; readonly held: IdeaQueueHeldPayload }
  | { readonly kind: 'play'; readonly playId: string; readonly state: string }
  | { readonly kind: 'shellStarted'; readonly command: ShellCommandStartedPayload }
  | {
      readonly kind: 'shellFinished';
      readonly result: ShellCommandFinishedPayload;
      readonly snippet: string;
    }
  | { readonly kind: 'command'; readonly result: SlashCommandResult }
  | { readonly kind: 'error'; readonly error: ApiErrorBody }
  /** A line of the TUI itself: `key` is under `layout.chat.local` in the catalog. */
  | {
      readonly kind: 'local';
      readonly key: string;
      readonly params: Readonly<Record<string, string | number>>;
    };

export interface ChatEntry {
  readonly id: string;
  readonly who: 'you' | 'director' | 'system';
  /** Epoch milliseconds. */
  readonly at: number;
  readonly body: EntryBody;
  /** The message of the Producer waits (the Director is in a turn, or the box holds it). */
  readonly queued?: boolean | undefined;
  /** The turn of the Director this text belongs to. */
  readonly replyId?: number | undefined;
  /** More parts of this reply are still to come. */
  readonly partial?: boolean | undefined;
}

export interface PendingAsk {
  readonly decisionId: string;
  readonly kind: string;
  readonly playId: string | null;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A command that asked for a confirmation. */
export interface PendingConfirm {
  /** The line the Producer typed, to send again with `confirm: true`. */
  readonly text: string;
  readonly command: string;
  /** What the daemon says about it. */
  readonly prompt: string;
}

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly nextId: number;
  readonly asks: readonly PendingAsk[];
  /** The decisions that were closed, so a late `ask` does not bring one back. */
  readonly closed: readonly string[];
  /** The highest `eventId` applied of the frames that stand for one event of the log. */
  readonly lastEvent: number;
  /** `replyId` to the highest `eventId` applied to that reply. */
  readonly replies: Readonly<Record<number, number>>;
  readonly busy: boolean;
  readonly waits: readonly ChatWait[];
  readonly connection: ConnectionState;
  /** Whether the socket was open once (to tell a first opening from a coming back). */
  readonly everOpen: boolean;
  /** The decision whose answer was sent and not yet closed by the daemon. */
  readonly answering: string | undefined;
  readonly confirm: PendingConfirm | undefined;
  /** The line of the last `command` sent, for the confirmation. */
  readonly lastCommand: string | undefined;
}

export type ChatEvent =
  | { readonly type: 'frame'; readonly frame: ChatServerMessage; readonly at: number }
  | {
      readonly type: 'sent';
      readonly text: string;
      readonly at: number;
      readonly queued: boolean;
    }
  | { readonly type: 'released'; readonly entryId: string }
  | { readonly type: 'commandSent'; readonly text: string }
  | { readonly type: 'answerSent'; readonly decisionId: string }
  | { readonly type: 'connection'; readonly state: ConnectionState; readonly at: number }
  | { readonly type: 'confirmDone' }
  | {
      readonly type: 'local';
      readonly key: string;
      readonly params?: Readonly<Record<string, string | number>>;
      readonly at: number;
    };

export function createChatState(): ChatState {
  return {
    entries: [],
    nextId: 1,
    asks: [],
    closed: [],
    lastEvent: 0,
    replies: {},
    busy: false,
    waits: [],
    connection: 'connecting',
    everOpen: false,
    answering: undefined,
    confirm: undefined,
    lastCommand: undefined,
  };
}

/** The most entries kept in memory; the oldest go first (the layout draws a window anyway). */
export const MAX_ENTRIES = 5000;

function push(
  state: ChatState,
  entry: Omit<ChatEntry, 'id'>,
  patch: Partial<ChatState> = {},
): ChatState {
  const entries = [...state.entries, { ...entry, id: `e${String(state.nextId)}` }];
  return {
    ...state,
    ...patch,
    entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries,
    nextId: state.nextId + 1,
  };
}

function reply(
  state: ChatState,
  frame: Extract<ChatServerMessage, { type: 'director_reply' }>,
  at: number,
): ChatState {
  const last = state.replies[frame.replyId] ?? 0;
  // A frame sent again after a resume: already applied.
  if (frame.eventId <= last) return state;
  const replies = { ...state.replies, [frame.replyId]: frame.eventId };
  // The Director answered: what was waiting for its turn has been taken.
  const entries = state.entries.map((entry) =>
    entry.queued === true ? { ...entry, queued: false } : entry,
  );
  const base = { ...state, replies, entries };
  if (frame.generated === true) {
    return push(
      base,
      {
        who: 'director',
        at,
        replyId: frame.replyId,
        body: { kind: 'generated', tools: frame.tools ?? [], playId: frame.playId },
      },
      {},
    );
  }
  const at$ = base.entries.findIndex(
    (entry) => entry.replyId === frame.replyId && entry.body.kind === 'text',
  );
  const existing = at$ === -1 ? undefined : base.entries[at$];
  if (existing !== undefined && existing.body.kind === 'text') {
    const merged: ChatEntry = {
      ...existing,
      body: { kind: 'text', text: existing.body.text + frame.text },
      partial: !frame.final,
    };
    return {
      ...base,
      entries: base.entries.map((entry, index) => (index === at$ ? merged : entry)),
    };
  }
  return push(base, {
    who: 'director',
    at,
    replyId: frame.replyId,
    partial: !frame.final,
    body: { kind: 'text', text: frame.text },
  });
}

/** An event-like frame: applied once, in the order of the log. */
function once(state: ChatState, eventId: number, make: (state: ChatState) => ChatState): ChatState {
  if (eventId <= state.lastEvent) return state;
  return make({ ...state, lastEvent: eventId });
}

function applyFrame(state: ChatState, frame: ChatServerMessage, at: number): ChatState {
  switch (frame.type) {
    case 'director_reply':
      return reply(state, frame, at);
    case 'ask': {
      if (state.closed.includes(frame.decisionId)) return state;
      if (state.asks.some((ask) => ask.decisionId === frame.decisionId)) return state;
      const ask: PendingAsk = {
        decisionId: frame.decisionId,
        kind: frame.kind,
        playId: frame.playId,
        input: frame.input,
      };
      return { ...state, asks: [...state.asks, ask] };
    }
    case 'ask_closed': {
      const closed = state.closed.includes(frame.decisionId)
        ? state.closed
        : [...state.closed, frame.decisionId];
      return {
        ...state,
        closed,
        asks: state.asks.filter((ask) => ask.decisionId !== frame.decisionId),
        answering: state.answering === frame.decisionId ? undefined : state.answering,
      };
    }
    case 'system':
      return once(state, frame.eventId, (next) =>
        push(next, { who: 'system', at, body: { kind: 'system', notice: frame.message } }),
      );
    case 'queue_held':
      return once(state, frame.eventId, (next) =>
        push(next, { who: 'system', at, body: { kind: 'held', held: frame.held } }),
      );
    case 'play_state':
      return once(state, frame.eventId, (next) =>
        push(next, {
          who: 'system',
          at,
          body: { kind: 'play', playId: frame.playId, state: frame.state },
        }),
      );
    case 'shell_started':
      return once(state, frame.eventId, (next) =>
        push(next, { who: 'system', at, body: { kind: 'shellStarted', command: frame.command } }),
      );
    case 'shell_finished':
      return once(state, frame.eventId, (next) =>
        push(next, {
          who: 'system',
          at,
          body: { kind: 'shellFinished', result: frame.result, snippet: frame.snippet },
        }),
      );
    case 'waits':
      return { ...state, waits: frame.waits };
    case 'busy':
      return {
        ...state,
        busy: frame.busy,
        entries: frame.busy
          ? state.entries
          : state.entries.map((entry) =>
              entry.queued === true && entry.who === 'you' ? { ...entry, queued: false } : entry,
            ),
      };
    case 'command_result': {
      const pending =
        frame.result.status === 'confirm' && state.lastCommand !== undefined
          ? {
              text: state.lastCommand,
              command: frame.result.command,
              prompt: frame.result.text,
            }
          : undefined;
      return push(
        state,
        { who: 'system', at, body: { kind: 'command', result: frame.result } },
        { confirm: pending },
      );
    }
    case 'error':
      return push(
        state,
        { who: 'system', at, body: { kind: 'error', error: frame.error } },
        // An answer the daemon refused is still pending: the Producer can answer again.
        { answering: undefined, confirm: undefined },
      );
  }
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'frame':
      return applyFrame(state, event.frame, event.at);
    case 'sent':
      return push(state, {
        who: 'you',
        at: event.at,
        queued: event.queued,
        body: { kind: 'text', text: event.text },
      });
    case 'released':
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === event.entryId ? { ...entry, queued: false } : entry,
        ),
      };
    case 'commandSent':
      return { ...state, lastCommand: event.text, confirm: undefined };
    case 'answerSent':
      return { ...state, answering: event.decisionId };
    case 'confirmDone':
      return { ...state, confirm: undefined };
    case 'connection': {
      if (event.state === state.connection) return state;
      const base = { ...state, connection: event.state };
      // Leaving the chat (or a socket that ended) is not a drop: the next opening is a first one.
      if (event.state === 'closed') return { ...base, everOpen: false };
      if (event.state === 'open') {
        const back = state.everOpen;
        const next = { ...base, everOpen: true };
        return back
          ? push(next, {
              who: 'system',
              at: event.at,
              body: { kind: 'local', key: 'reconnected', params: {} },
            })
          : next;
      }
      if (event.state === 'retrying' && state.everOpen && state.connection === 'open') {
        return push(base, {
          who: 'system',
          at: event.at,
          body: { kind: 'local', key: 'connectionLost', params: {} },
        });
      }
      return base;
    }
    case 'local':
      return push(state, {
        who: 'system',
        at: event.at,
        body: { kind: 'local', key: event.key, params: event.params ?? {} },
      });
  }
}
