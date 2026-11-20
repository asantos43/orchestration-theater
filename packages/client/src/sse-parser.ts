// SPDX-License-Identifier: MPL-2.0

/**
 * Parser of `text/event-stream` (plan docs/17 P10), written to the HTML Living Standard's
 * "Server-sent events" section (the parsing and the "dispatch the event" steps), so the client
 * needs neither `EventSource` (it cannot send `Authorization`) nor a library (N164). It is pure
 * and synchronous: bytes or text in, items out, no I/O, so it runs in Node and in a browser.
 */

/** A message of the stream, as the specification dispatches it. */
export interface SseEvent {
  readonly kind: 'event';
  /** The last event id seen so far in the stream (it survives from one event to the next). */
  readonly id: string;
  /** The `event:` field, or `message` when the event had none. */
  readonly event: string;
  /** The `data:` lines joined with `\n`, without the last `\n`. */
  readonly data: string;
}

/** A valid `retry:` field: the server's reconnection time, in milliseconds. */
export interface SseRetry {
  readonly kind: 'retry';
  readonly ms: number;
}

/** A comment line (`: ...`): the heartbeat of the daemon. */
export interface SseComment {
  readonly kind: 'comment';
  readonly text: string;
}

export type SseItem = SseEvent | SseRetry | SseComment;

const BOM = '﻿';

export class SseParser {
  /** Text of an unfinished line, held until its terminator arrives. */
  #line = '';
  /** The last chunk ended with `\r`: a `\n` at the start of the next one belongs to it. */
  #skipLineFeed = false;
  #started = false;
  #data = '';
  #hasData = false;
  #eventType = '';
  /** The "last event ID buffer": set by an `id:` line, made the last event id at the blank line. */
  #idBuffer = '';
  #lastEventId = '';

  /**
   * The "last event ID string" of the specification: what a reconnection sends back. An `id:` line
   * counts only once its blank line arrives, so half a frame cut by a dropped connection never
   * moves it.
   */
  get lastEventId(): string {
    return this.#lastEventId;
  }

  /**
   * Feeds a piece of the stream and returns what it completed, in order. A piece may end
   * anywhere: inside a field name, between `\r` and `\n`, so the parser keeps the rest.
   */
  write(chunk: string): SseItem[] {
    let text = chunk;
    if (!this.#started && text.length > 0) {
      this.#started = true;
      if (text.startsWith(BOM)) text = text.slice(1);
    }
    const items: SseItem[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (this.#skipLineFeed) {
        this.#skipLineFeed = false;
        if (char === '\n') {
          start = index + 1;
          continue;
        }
      }
      if (char !== '\r' && char !== '\n') continue;
      this.#processLine(this.#line + text.slice(start, index), items);
      this.#line = '';
      start = index + 1;
      if (char === '\r') {
        // A `\n` right after is the second half of `\r\n`, wherever the chunk ends.
        if (text[index + 1] === '\n') {
          index += 1;
          start = index + 1;
        } else if (index + 1 === text.length) {
          this.#skipLineFeed = true;
        }
      }
    }
    this.#line += text.slice(start);
    return items;
  }

  /**
   * The stream ended. What is pending (a line with no terminator, an event with no blank line
   * after it) is discarded, as the specification says: a dropped connection never delivers half
   * an event, and the reconnection asks for it again with `Last-Event-ID`.
   */
  end(): void {
    this.#line = '';
    this.#skipLineFeed = false;
    this.#data = '';
    this.#hasData = false;
    this.#eventType = '';
    this.#idBuffer = this.#lastEventId;
  }

  #processLine(line: string, items: SseItem[]): void {
    if (line === '') {
      this.#dispatch(items);
      return;
    }
    if (line.startsWith(':')) {
      items.push({ kind: 'comment', text: line.slice(1).replace(/^ /, '') });
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#data += `${value}\n`;
        this.#hasData = true;
        break;
      case 'id':
        // An id with a NUL is ignored; an empty one resets the last event id.
        if (!value.includes('\0')) this.#idBuffer = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) items.push({ kind: 'retry', ms: Number(value) });
        break;
      default:
        // Unknown fields are ignored.
        break;
    }
  }

  #dispatch(items: SseItem[]): void {
    this.#lastEventId = this.#idBuffer;
    if (this.#hasData) {
      items.push({
        kind: 'event',
        id: this.#lastEventId,
        event: this.#eventType === '' ? 'message' : this.#eventType,
        data: this.#data.slice(0, -1),
      });
    }
    // An event with no `data` is not dispatched, but its `id` stays (it is a cursor).
    this.#data = '';
    this.#hasData = false;
    this.#eventType = '';
  }
}

/**
 * Reads a response body to the end and yields it as text. A `TextDecoder` in streaming mode keeps
 * a multibyte character that a chunk cut in two, and leaves the BOM to the parser. Leaving the
 * loop early, or an abort, cancels the body so the connection does not stay open. An abort or a
 * dropped connection makes the reader throw: the caller handles that.
 */
export async function* readSseText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text !== '') yield text;
    }
    finished = true;
    const rest = decoder.decode();
    if (rest !== '') yield rest;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
