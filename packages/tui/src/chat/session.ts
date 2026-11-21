// SPDX-License-Identifier: MPL-2.0
import type { ChatOutgoing, ConnectionState } from '@otheater/client';
import type { ChatServerMessage } from '@otheater/protocol';
import { createChatState, reduceChat, type ChatEvent, type ChatState } from './model.js';

/** The part of `ChatSocket` the session uses; the real socket and a fake one both fit. */
export interface ChatSocketLike {
  readonly state: ConnectionState;
  readonly lastEventId: number | undefined;
  onMessage(listener: (message: ChatServerMessage) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  send(message: ChatOutgoing): void;
  start(): unknown;
  close(): void;
}

/** `ui.chat.queue`: who keeps a message of the Producer while the Director is busy. */
export type ChatQueueMode = 'daemon' | 'hold';

export interface ChatSessionOptions {
  /** Opens a socket of the scenario, from the cursor of the session (`resumeFrom`), if it has one. */
  readonly open: (resumeFrom: number | undefined) => ChatSocketLike;
  readonly now: () => number;
  readonly queue: ChatQueueMode;
}

interface Held {
  readonly entryId: string;
  readonly text: string;
  readonly attachments: readonly string[];
}

/**
 * The chat of one scenario: a socket, the state it feeds and what the Producer can do. The state
 * outlives the socket: leaving the scenario closes the socket and keeps the cursor, and coming back
 * opens another from that cursor (`resume`), so what happened meanwhile arrives once.
 */
export class ChatSession {
  readonly #options: ChatSessionOptions;
  readonly #listeners = new Set<() => void>();
  readonly #stops: (() => void)[] = [];
  readonly #held: Held[] = [];
  #state: ChatState = createChatState();
  #socket: ChatSocketLike | undefined;
  #cursor: number | undefined;
  #queue: ChatQueueMode;

  constructor(options: ChatSessionOptions) {
    this.#options = options;
    this.#queue = options.queue;
  }

  get state(): ChatState {
    return this.#state;
  }

  /** `ui.chat.queue` may change while the TUI runs. */
  setQueueMode(mode: ChatQueueMode): void {
    this.#queue = mode;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Opens the socket (once); the state of before is kept. */
  connect(): void {
    if (this.#socket !== undefined) return;
    const socket = this.#options.open(this.#cursor);
    this.#socket = socket;
    this.#stops.push(
      socket.onMessage((frame) => {
        this.#cursor = socket.lastEventId ?? this.#cursor;
        this.#dispatch({ type: 'frame', frame, at: this.#options.now() });
        if (frame.type === 'busy' && !frame.busy) this.#flush();
      }),
      socket.onState((state) => {
        this.#dispatch({ type: 'connection', state, at: this.#options.now() });
      }),
    );
    socket.start();
  }

  /** Closes the socket and keeps the cursor and the state. */
  disconnect(): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    this.#cursor = socket.lastEventId ?? this.#cursor;
    for (const stop of this.#stops.splice(0)) stop();
    this.#socket = undefined;
    socket.close();
    this.#dispatch({ type: 'connection', state: 'closed', at: this.#options.now() });
  }

  dispose(): void {
    this.disconnect();
    this.#listeners.clear();
  }

  /**
   * What the Producer typed: a line with a slash is a command, anything else a message for the
   * Director. Throws when the socket is not open (the text box keeps the text and says so).
   */
  submit(text: string, attachments: readonly string[] = []): void {
    if (/^\/\S/.test(text) && attachments.length === 0) {
      this.sendCommand(text);
      return;
    }
    this.sendMessage(text, attachments);
  }

  sendMessage(text: string, attachments: readonly string[] = []): void {
    const busy = this.#state.busy;
    if (this.#queue === 'hold' && busy) {
      this.#dispatch({ type: 'sent', text, at: this.#options.now(), queued: true });
      const last = this.#state.entries[this.#state.entries.length - 1];
      if (last !== undefined) this.#held.push({ entryId: last.id, text, attachments });
      return;
    }
    this.#require().send(messageOf(text, attachments));
    this.#dispatch({ type: 'sent', text, at: this.#options.now(), queued: busy });
  }

  sendCommand(text: string, confirm?: boolean): void {
    const socket = this.#require();
    this.#dispatch({ type: 'commandSent', text });
    socket.send(confirm === true ? { type: 'command', text, confirm } : { type: 'command', text });
    if (confirm === true) this.#dispatch({ type: 'confirmDone' });
    else this.#dispatch({ type: 'sent', text, at: this.#options.now(), queued: false });
  }

  /** Answers a decision. `summary` is what the conversation says the Producer answered. */
  answer(decisionId: string, answer: Record<string, unknown>, summary: string): void {
    this.#require().send({
      type: 'answer',
      decisionId,
      answer: answer as Record<string, never>,
    });
    this.#dispatch({ type: 'answerSent', decisionId });
    this.#dispatch({ type: 'sent', text: summary, at: this.#options.now(), queued: false });
  }

  /** Stops the reply of the Director in course (`/stop`); the play goes on. */
  stop(): void {
    this.#require().send({ type: 'command', text: '/stop' });
    this.#dispatch({ type: 'commandSent', text: '/stop' });
  }

  /** The Producer gave up a command that asked for a confirmation. */
  cancelConfirm(): void {
    this.#dispatch({ type: 'confirmDone' });
  }

  local(key: string, params?: Record<string, string | number>): void {
    this.#dispatch({
      type: 'local',
      key,
      at: this.#options.now(),
      ...(params === undefined ? {} : { params }),
    });
  }

  #require(): ChatSocketLike {
    const socket = this.#socket;
    if (socket === undefined) throw new Error('the chat is not connected');
    return socket;
  }

  #flush(): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    while (this.#held.length > 0) {
      const next = this.#held[0];
      if (next === undefined) return;
      try {
        socket.send(messageOf(next.text, next.attachments));
      } catch {
        // Not open: it stays held and goes at the next `busy: false`.
        return;
      }
      this.#held.shift();
      this.#dispatch({ type: 'released', entryId: next.entryId });
    }
  }

  #dispatch(event: ChatEvent): void {
    this.#state = reduceChat(this.#state, event);
    for (const listener of [...this.#listeners]) listener();
  }
}

function messageOf(text: string, attachments: readonly string[]): ChatOutgoing {
  return attachments.length === 0
    ? { type: 'message', text }
    : { type: 'message', text, attachments: [...attachments] };
}
