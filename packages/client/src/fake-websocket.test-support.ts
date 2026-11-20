// SPDX-License-Identifier: MPL-2.0
import type { WebSocketConstructor, WebSocketEventLike, WebSocketLike } from './chat-socket.js';

/**
 * A `WebSocket` that does nothing by itself, for the tests of the chat client (N57). The test
 * opens it, feeds it frames and drops it. The test against a real server (the `ws` of P7) enters
 * in P13.
 */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, ((event: WebSocketEventLike) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('the fake socket is not open');
    this.sent.push(data);
  }

  /** The client closes it. */
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit('close', { code: code ?? 1005, reason: reason ?? '' });
  }

  /** The daemon accepts the upgrade. */
  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  /** A frame from the daemon: an object is sent as JSON, a string as it is. */
  receive(frame: unknown): void {
    this.#emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  /** A binary frame. */
  receiveBinary(bytes: Uint8Array): void {
    this.#emit('message', { data: bytes });
  }

  /** The connection falls (or the daemon closes it). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.#emit('error', {});
    this.#emit('close', { code, reason: '' });
  }

  /** The frames the client sent, parsed. */
  sentMessages(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame) as unknown);
  }

  #emit(type: string, event: WebSocketEventLike): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export interface FakeSockets {
  readonly Socket: WebSocketConstructor;
  /** Every socket the client made, in order. */
  readonly sockets: FakeWebSocket[];
}

export function createFakeSockets(): FakeSockets {
  const sockets: FakeWebSocket[] = [];
  class Made extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return { Socket: Made, sockets };
}
