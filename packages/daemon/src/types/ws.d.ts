// SPDX-License-Identifier: MPL-2.0
// [proposta] The part of `ws` 8.23.0 the daemon uses, written by hand: the authorization of N164
// allows the package and nothing else (no `@types/ws`). Anything not listed here is not used.
declare module 'ws' {
  import type { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  /** What a `message` event hands over: one buffer, or the fragments of a message. */
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    /** The client side, which only the tests use: `autoPong: false` is a client that never answers a ping. */
    constructor(address: string, options?: { readonly autoPong?: boolean });
    /** 0 connecting, 1 open, 2 closing, 3 closed. */
    readonly readyState: 0 | 1 | 2 | 3;
    readonly protocol: string;
    readonly bufferedAmount: number;
    close(code?: number, reason?: string): void;
    /** Ends the socket at once, with no close frame. */
    terminate(): void;
    ping(data?: unknown, mask?: boolean, callback?: (error?: Error) => void): void;
    send(
      data: string | ArrayBuffer | ArrayBufferView,
      options?: { compress?: boolean },
      callback?: (error?: Error) => void,
    ): void;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: 'pong', listener: (data: Buffer) => void): this;
    once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  }

  export interface ServerOptions {
    /** The server never listens: the upgrade of an existing HTTP server is handed to it. */
    readonly noServer?: boolean;
    /** Largest message accepted, in bytes (default 100 MiB). Past it the socket ends with 1009. */
    readonly maxPayload?: number;
    /** Pongs owed to a client that floods pings; past it the socket is terminated (default 60). */
    readonly maxPendingAutoPongs?: number;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: ServerOptions);
    readonly options: ServerOptions;
    /** The open sockets. */
    readonly clients: Set<WebSocket>;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket, request: IncomingMessage) => void,
    ): void;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'headers', listener: (headers: string[], request: IncomingMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
}
