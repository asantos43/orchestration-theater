// SPDX-License-Identifier: MPL-2.0

/**
 * Output truncation of the shell tools (architecture 5.8, N98). A stream is cut to
 * `tools.output_max_bytes`; the result says the original size and that it was cut, so the model
 * knows the text is not the whole.
 */

/**
 * Which part of the output is kept (`tools.truncate`): the `head`, the `tail` (a failing test
 * prints its summary last) or both halves with the mark in the middle. [proposta]
 */
export const TRUNCATE_MODES = ['head', 'tail', 'head_tail'] as const;
export type TruncateMode = (typeof TRUNCATE_MODES)[number];

/** A stream after the limit: the kept text, the size it had and whether anything was dropped. */
export interface TruncatedOutput {
  readonly text: string;
  readonly truncated: boolean;
  /** Size of the whole output, in bytes. */
  readonly originalBytes: number;
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** Index of the first byte at or after `start` that begins a UTF-8 character. */
function skipContinuation(bytes: Uint8Array, start: number): number {
  let i = start;
  while (i < bytes.length && ((bytes[i] ?? 0) & 0xc0) === 0x80) i++;
  return i;
}

/** Length of `bytes` without a last UTF-8 character that the cut left incomplete. */
function dropIncompleteTail(bytes: Uint8Array): number {
  let start = bytes.length - 1;
  while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
  if (start < 0) return 0;
  const lead = bytes[start] ?? 0;
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start >= needed ? bytes.length : start;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The mark inserted where bytes were dropped. */
export function truncationMark(dropped: number, total: number): string {
  return `\n[... ${dropped} of ${total} bytes truncated ...]\n`;
}

/**
 * Collects a stream chunk by chunk and keeps only what the mode asks for, so a command that
 * prints gigabytes never fills the memory of the daemon. `result()` is the text with the mark.
 */
export class OutputCollector {
  readonly #headMax: number;
  readonly #tailMax: number;
  readonly #head: Uint8Array[] = [];
  #headBytes = 0;
  readonly #tail: Uint8Array[] = [];
  #tailBytes = 0;
  #total = 0;

  constructor(maxBytes: number, mode: TruncateMode = 'head_tail') {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive integer');
    }
    if (mode === 'head') {
      this.#headMax = maxBytes;
      this.#tailMax = 0;
    } else if (mode === 'tail') {
      this.#headMax = 0;
      this.#tailMax = maxBytes;
    } else {
      this.#headMax = Math.ceil(maxBytes / 2);
      this.#tailMax = maxBytes - this.#headMax;
    }
  }

  /** Bytes pushed so far, kept or not. */
  get totalBytes(): number {
    return this.#total;
  }

  push(chunk: Uint8Array): void {
    this.#total += chunk.length;
    let rest = chunk;
    const room = this.#headMax - this.#headBytes;
    if (room > 0) {
      const take = rest.subarray(0, room);
      this.#head.push(take.slice());
      this.#headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0 || this.#tailMax === 0) return;
    const kept = rest.slice(Math.max(0, rest.length - this.#tailMax));
    this.#tail.push(kept);
    this.#tailBytes += kept.length;
    while (
      this.#tail.length > 1 &&
      this.#tailBytes - (this.#tail[0]?.length ?? 0) >= this.#tailMax
    ) {
      this.#tailBytes -= this.#tail.shift()?.length ?? 0;
    }
  }

  result(): TruncatedOutput {
    const head = concat(this.#head, this.#headBytes);
    let tail = concat(this.#tail, this.#tailBytes);
    if (tail.length > this.#tailMax) tail = tail.subarray(tail.length - this.#tailMax);
    if (head.length + tail.length === this.#total) {
      return {
        text: decoder.decode(concat([head, tail], this.#total)),
        truncated: false,
        originalBytes: this.#total,
      };
    }
    const headPart = head.subarray(0, dropIncompleteTail(head));
    const tailPart = tail.subarray(skipContinuation(tail, 0));
    const dropped = this.#total - headPart.length - tailPart.length;
    const text =
      decoder.decode(headPart) + truncationMark(dropped, this.#total) + decoder.decode(tailPart);
    return { text, truncated: true, originalBytes: this.#total };
  }
}

/** Truncates a string already in memory (a diff, a response body) the same way. */
export function truncateText(
  text: string,
  maxBytes: number,
  mode: TruncateMode = 'head_tail',
): TruncatedOutput {
  const collector = new OutputCollector(maxBytes, mode);
  collector.push(encoder.encode(text));
  return collector.result();
}
