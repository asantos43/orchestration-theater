// SPDX-License-Identifier: MPL-2.0

/** Small deterministic PRNG (mulberry32): the same seed always gives the same payloads. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ ';

/** Incompressible-looking ASCII text of exactly `length` characters. */
export function randomText(rng: () => number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) text += ALPHABET.charAt(Math.floor(rng() * ALPHABET.length));
  return text;
}

/** Fixed JSON overhead of `{ n, text }` around the text (key names, quotes, a 7-digit counter). */
const PAYLOAD_OVERHEAD_BYTES = 24;

export interface BenchPayload {
  readonly n: number;
  readonly text: string;
}

/** A pool of payloads whose JSON is about `bytes` long, to be reused in a loop. */
export function payloadPool(rng: () => number, bytes: number, count: number): string[] {
  return Array.from({ length: count }, () =>
    randomText(rng, Math.max(1, bytes - PAYLOAD_OVERHEAD_BYTES)),
  );
}

/** A pool with texts of varied length (`minBytes`..`maxBytes`), like real event payloads. */
export function variedPayloadPool(
  rng: () => number,
  minBytes: number,
  maxBytes: number,
  count: number,
): string[] {
  return Array.from({ length: count }, () =>
    randomText(
      rng,
      Math.max(1, Math.floor(minBytes + rng() * (maxBytes - minBytes)) - PAYLOAD_OVERHEAD_BYTES),
    ),
  );
}
