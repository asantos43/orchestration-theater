// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { ApiFailure } from './handlers.js';

/** What `issue` hands out: the ticket and how long it is good for. */
export interface IssuedTicket {
  readonly ticket: string;
  readonly expiresInMs: number;
}

export interface ChatTicketsOptions {
  /** `api.chat.ticket_ttl`, in milliseconds. */
  readonly ttlMs: number;
  /** The clock of the daemon (a fake one in the tests). */
  readonly now: () => number;
  /** `api.chat.max_tickets`: tickets that may wait at once. Default: no cap (the tests of the tickets alone). */
  readonly maxTickets?: number;
  /**
   * The epoch of the API token now (`ApiServer.tokenEpoch`). A ticket remembers the epoch of the call
   * that asked for it and is good only while the token has not been rotated since. Default: always 0.
   */
  readonly epoch?: () => number;
}

interface Entry {
  readonly scenarioId: string;
  readonly expiresAt: number;
  readonly epoch: number;
}

/**
 * The tickets of the chat socket (P7 of docs/17). A browser cannot set `Authorization` on a
 * WebSocket, and the token must never go in a URL, so the client trades the token (on a REST call)
 * for a ticket that opens one socket, of one scenario, once, within `api.chat.ticket_ttl`.
 *
 * [proposta] The tickets live in memory only: a restart of the daemon invalidates them, which is
 * what a ticket of 30 s wants. A ticket is 32 random bytes in base64url. `redeem` removes the ticket
 * whatever the answer, so a ticket that was tried for another scenario is also gone (it is one try).
 * Every ticket lives the same time, so the map (which keeps the order of insertion) is ordered by
 * expiry too: a purge walks from the oldest and stops at the first ticket that is still good, so it
 * costs what it removes and not what is held. At most `api.chat.max_tickets` wait at once; past it a
 * request is `503 unavailable` (the expired ones are dropped first). A ticket also remembers the epoch
 * of the token of the call that asked for it, so one asked for with a token that was rotated since is
 * refused, issued or redeemed.
 */
export class ChatTickets {
  readonly #options: ChatTicketsOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: ChatTicketsOptions) {
    this.#options = options;
  }

  /** How many tickets are held (expired ones included until the next purge). */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * A ticket for `scenarioId`. `epoch` is the epoch of the token of the call that asks (the default,
   * the current one, is for the tests); a call whose token was rotated while it ran is `401`.
   */
  issue(scenarioId: string, epoch: number = this.#currentEpoch()): IssuedTicket {
    if (epoch !== this.#currentEpoch()) {
      throw new ApiFailure('unauthorized', 'The API token was rotated', {
        headers: { 'www-authenticate': 'Bearer realm="otheater"' },
      });
    }
    this.#purge();
    const max = this.#options.maxTickets;
    if (max !== undefined && this.#entries.size >= max) {
      throw new ApiFailure('unavailable', 'Too many chat tickets are waiting', {
        details: { maxTickets: max },
        headers: { 'retry-after': String(Math.max(1, Math.ceil(this.#options.ttlMs / 1000))) },
      });
    }
    const ticket = randomBytes(32).toString('base64url');
    this.#entries.set(ticket, {
      scenarioId,
      expiresAt: this.#options.now() + this.#options.ttlMs,
      epoch,
    });
    return { ticket, expiresInMs: this.#options.ttlMs };
  }

  /**
   * True once for a ticket that was issued for `scenarioId`, has not expired and was asked for with
   * the token that is current; the ticket is gone either way.
   */
  redeem(ticket: string, scenarioId: string): boolean {
    this.#purge();
    const entry = this.#entries.get(ticket);
    this.#entries.delete(ticket);
    return (
      entry?.scenarioId === scenarioId &&
      entry.expiresAt > this.#options.now() &&
      entry.epoch === this.#currentEpoch()
    );
  }

  /** Drops every ticket (the token was rotated: what it vouched for is no longer vouched for). */
  clear(): void {
    this.#entries.clear();
  }

  #currentEpoch(): number {
    return this.#options.epoch?.() ?? 0;
  }

  /** Drops the expired tickets, oldest first, and stops at the first one that is still good. */
  #purge(): void {
    const now = this.#options.now();
    for (const [ticket, entry] of this.#entries) {
      if (entry.expiresAt > now) return;
      this.#entries.delete(ticket);
    }
  }
}
