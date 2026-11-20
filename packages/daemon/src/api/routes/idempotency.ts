// SPDX-License-Identifier: MPL-2.0
import { createHmac, randomBytes } from 'node:crypto';
import type { Clock, JsonValue } from '@otheater/core';
import { ApiFailure } from '../handlers.js';

/**
 * The idempotency of the commands of the REST API (P6 of docs/17). A client that sends an
 * `Idempotency-Key` with a command may send it again (a request that timed out, a reconnection):
 * the daemon runs the command once and answers the repeat with the first answer.
 *
 * [proposta] The rules, all of them the daemon's own and none in the protocol but the key's shape:
 * - the key is global, not per route: the same key with another route, another path parameter, another
 *   query or another body is a different request and answers 409 `conflict`;
 * - what is remembered is the SUCCESSFUL answer: a command that failed ran no effect (or did not
 *   finish it), so a repeat tries again instead of replaying the failure;
 * - a repeat that arrives while the first run is still going waits for it and gets its answer, so two
 *   sends at once never run the command twice;
 * - the answers are kept for `api.idempotency_ttl` (24 hours by default; `0` remembers nothing), read
 *   from the clock of the daemon, and swept as the cache is used;
 * - the memory is the daemon's: a restart forgets the keys. The alternative, a table of the store,
 *   would need a migration and a change to every store adapter of the core for a window of one day;
 *   the commands that a restart could let run twice are the ones that make a new record (`openScenario`,
 *   `createOrder`, `addIdea`, `addAttachment`), and a client that cares reads the resource back first;
 * - the request is recognized by a keyed digest (HMAC-SHA256 with a key that lives in this process and
 *   is never written), never by a copy: a body may carry an API key (`addProfile`), and the cache holds
 *   neither it nor an unkeyed hash that could be tested against a guess.
 */

/** What a replayed answer is marked with, so a client can tell it from the first run. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

/** How long a swept cache waits before it sweeps again, in milliseconds of the clock. */
const SWEEP_EVERY_MS = 60_000;

/** JSON with the keys of every object sorted, so two spellings of one body have one text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, child]) => `${JSON.stringify(name)}:${canonicalJson(child)}`);
  return `{${entries.join(',')}}`;
}

interface Settled {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly value: JsonValue;
}

interface Running {
  readonly fingerprint: string;
  readonly promise: Promise<JsonValue>;
}

/** A request as the cache sees it: its key and what makes one request different from another. */
export interface IdempotentRequest {
  readonly key: string;
  readonly routeId: string;
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}

export interface IdempotencyCacheOptions {
  readonly clock: Clock;
  /** How long an answer is kept, in milliseconds; `0` keeps nothing (a getter: the config may change). */
  readonly ttlMs: () => number;
}

export class IdempotencyCache {
  readonly #options: IdempotencyCacheOptions;
  readonly #secret = randomBytes(32);
  readonly #settled = new Map<string, Settled>();
  readonly #running = new Map<string, Running>();
  #sweptAt = 0;

  constructor(options: IdempotencyCacheOptions) {
    this.#options = options;
  }

  /** The keys the cache holds now (answers kept and runs going), for the tests. */
  get size(): number {
    return this.#settled.size + this.#running.size;
  }

  #fingerprintOf(request: IdempotentRequest): string {
    return createHmac('sha256', this.#secret)
      .update(
        [
          request.routeId,
          canonicalJson(request.params),
          canonicalJson(request.query),
          canonicalJson(request.body),
        ].join('\u0000'),
      )
      .digest('hex');
  }

  #sweep(now: number): void {
    if (now - this.#sweptAt < SWEEP_EVERY_MS) return;
    this.#sweptAt = now;
    for (const [key, entry] of this.#settled) {
      if (entry.expiresAt <= now) this.#settled.delete(key);
    }
  }

  /**
   * Runs `execute` once for the key. Gives `{ replayed: false, value }` for the run that did the
   * work and `{ replayed: true, value }` for a repeat (the first answer, kept or still coming).
   * Throws 409 `conflict` when the key was used by another request, and what `execute` throws.
   */
  async run(
    request: IdempotentRequest,
    execute: () => Promise<JsonValue>,
  ): Promise<{ readonly replayed: boolean; readonly value: JsonValue }> {
    const ttl = this.#options.ttlMs();
    if (ttl <= 0) return { replayed: false, value: await execute() };
    const now = this.#options.clock.now();
    this.#sweep(now);
    const fingerprint = this.#fingerprintOf(request);
    const { key } = request;
    for (;;) {
      const kept = this.#settled.get(key);
      if (kept !== undefined && kept.expiresAt <= this.#options.clock.now()) {
        this.#settled.delete(key);
      } else if (kept !== undefined) {
        this.#assertSame(kept.fingerprint, fingerprint, key);
        return { replayed: true, value: kept.value };
      }
      const running = this.#running.get(key);
      if (running === undefined) break;
      this.#assertSame(running.fingerprint, fingerprint, key);
      try {
        return { replayed: true, value: await running.promise };
      } catch {
        // The first run failed and left nothing behind: this one tries again (the loop looks again).
      }
    }
    const promise = execute();
    // A repeat that waits on this run handles its failure; the run itself surfaces it to its caller.
    promise.catch(() => undefined);
    this.#running.set(key, { fingerprint, promise });
    try {
      const value = await promise;
      this.#settled.set(key, {
        fingerprint,
        expiresAt: this.#options.clock.now() + ttl,
        value,
      });
      return { replayed: false, value };
    } finally {
      this.#running.delete(key);
    }
  }

  #assertSame(kept: string, given: string, key: string): void {
    if (kept === given) return;
    throw new ApiFailure(
      'conflict',
      'This Idempotency-Key was already used for a different request',
      { details: { idempotencyKey: key } },
    );
  }
}
