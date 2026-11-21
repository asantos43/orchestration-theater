// SPDX-License-Identifier: MPL-2.0
import type { ChatOutgoing, ConnectionState } from '@otheater/client';
import type { ChatServerMessage } from '@otheater/protocol';
import type { ChatSocketLike } from './session.js';

/**
 * A chat socket that the test drives (N57: nothing real runs): it records what the session sends
 * and plays the frames and the connection states the test gives it.
 */
export class FakeChatSocket implements ChatSocketLike {
  state: ConnectionState = 'connecting';
  lastEventId: number | undefined;
  readonly sent: ChatOutgoing[] = [];
  started = false;
  closed = false;
  /** The cursor the session asked to resume from when it opened this socket. */
  readonly resumeFrom: number | undefined;
  /** What the next `send` throws, when set (a socket that is not open). */
  failSend: Error | undefined;
  readonly #messages = new Set<(message: ChatServerMessage) => void>();
  readonly #states = new Set<(state: ConnectionState) => void>();

  constructor(resumeFrom?: number) {
    this.resumeFrom = resumeFrom;
    this.lastEventId = resumeFrom;
  }

  onMessage(listener: (message: ChatServerMessage) => void): () => void {
    this.#messages.add(listener);
    return () => {
      this.#messages.delete(listener);
    };
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#states.add(listener);
    return () => {
      this.#states.delete(listener);
    };
  }

  send(message: ChatOutgoing): void {
    if (this.failSend !== undefined) throw this.failSend;
    this.sent.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
    this.setState('closed');
  }

  setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.#states]) listener(state);
  }

  /** The daemon sends `frame`; the cursor moves as the real socket's does. */
  emit(frame: ChatServerMessage): void {
    if (frame.eventId !== null) {
      this.lastEventId = Math.max(this.lastEventId ?? 0, frame.eventId);
    }
    for (const listener of [...this.#messages]) listener(frame);
  }

  /** What the session sent of one type, in order. */
  sentOf<Type extends ChatOutgoing['type']>(type: Type): Extract<ChatOutgoing, { type: Type }>[] {
    return this.sent.filter(
      (message): message is Extract<ChatOutgoing, { type: Type }> => message.type === type,
    );
  }
}

/** The sockets a session opened, by scenario, newest last. */
export class FakeChatServer {
  readonly sockets = new Map<string, FakeChatSocket[]>();

  /** What `ApiClient.chat` is replaced with. */
  readonly open = (scenarioId: string, options?: { resumeFrom?: number }): FakeChatSocket => {
    const socket = new FakeChatSocket(options?.resumeFrom);
    const list = this.sockets.get(scenarioId) ?? [];
    list.push(socket);
    this.sockets.set(scenarioId, list);
    // A socket that starts is open at once, as a test of the view wants it.
    const start = socket.start.bind(socket);
    socket.start = (): void => {
      start();
      socket.setState('open');
    };
    return socket;
  };

  latest(scenarioId: string): FakeChatSocket | undefined {
    return this.sockets.get(scenarioId)?.at(-1);
  }
}
