// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the event stream only (excluded from the build of the package).
import type { ApiEventEnvelope } from '@otheater/protocol';

/** One block of an SSE stream, as the lines of the frame say it. */
export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly retry?: number;
  /** The `data:` lines joined with a newline. */
  readonly data?: string;
  /** The comment lines (`: text`), without the colon. */
  readonly comments: string[];
}

/** The `data` of an event frame: the envelope with the id of the daemon. */
export function frameData(frame: SseFrame): ApiEventEnvelope {
  if (frame.data === undefined) throw new Error('the frame has no data');
  return JSON.parse(frame.data) as ApiEventEnvelope;
}

/**
 * A small reader of `text/event-stream`: it splits the bytes into frames the way a client does. It
 * knows nothing of the daemon. `next` waits for a frame (rejecting after `timeoutMs`, so a test
 * that expects one never hangs), `done` says whether the server ended the stream.
 */
export class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = '';
  #ended = false;
  /** A read that timed out is kept, so the chunk it gets is not lost. */
  #pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The next frame, or `undefined` when the stream ended. */
  async next(timeoutMs = 2000): Promise<SseFrame | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const split = this.#buffer.indexOf('\n\n');
      if (split >= 0) {
        const block = this.#buffer.slice(0, split);
        this.#buffer = this.#buffer.slice(split + 2);
        return parseBlock(block);
      }
      if (this.#ended) return undefined;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no frame within ${String(timeoutMs)} ms`);
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        (this.#pending ??= this.#reader.read()),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout');
          }, left);
        }),
      ]);
      clearTimeout(timer);
      if (result !== 'timeout') this.#pending = undefined;
      if (result === 'timeout') throw new Error(`no frame within ${String(timeoutMs)} ms`);
      if (result.done) {
        this.#ended = true;
        this.#buffer += this.#decoder.decode();
      } else {
        this.#buffer += this.#decoder.decode(result.value, { stream: true });
      }
    }
  }

  /** The next frames until `count` event frames (with `data`) were read, skipping the rest. */
  async events(count: number, timeoutMs = 5000): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    while (out.length < count) {
      const frame = await this.next(timeoutMs);
      if (frame === undefined)
        throw new Error(`the stream ended after ${String(out.length)} events`);
      if (frame.data !== undefined) out.push(frame);
    }
    return out;
  }

  /** Whether the stream ends within `timeoutMs` (reading what is left). */
  async endsWithin(timeoutMs = 2000): Promise<boolean> {
    try {
      while ((await this.next(timeoutMs)) !== undefined) {
        // Drain.
      }
      return true;
    } catch (error) {
      // A connection the server cut is an end too; only a silence is not.
      return !(error instanceof Error && error.message.startsWith('no frame'));
    }
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

function parseBlock(block: string): SseFrame {
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'retry') retry = Number(value);
    else if (field === 'data') data.push(value);
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    ...(retry === undefined ? {} : { retry }),
    ...(data.length === 0 ? {} : { data: data.join('\n') }),
    comments,
  };
}
