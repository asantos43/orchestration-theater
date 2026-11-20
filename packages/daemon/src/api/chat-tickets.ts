// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';

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
}

interface Entry {
  readonly scenarioId: string;
  readonly expiresAt: number;
}

/**
 * The tickets of the chat socket (P7 of docs/17). A browser cannot set `Authorization` on a
 * WebSocket, and the token must never go in a URL, so the client trades the token (on a REST call)
 * for a ticket that opens one socket, of one scenario, once, within `api.chat.ticket_ttl`.
 *
 * [proposta] The tickets live in memory only: a restart of the daemon invalidates them, which is
 * what a ticket of 30 s wants. A ticket is 32 random bytes in base64url. `redeem` removes the ticket
 * whatever the answer, so a ticket that was tried for another scenario is also gone (it is one try).
 * Expired tickets that nobody redeems are purged each time one is issued or redeemed, so the map
 * does not grow with the tickets a client asked for and never used.
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

  issue(scenarioId: string): IssuedTicket {
    this.#purge();
    const ticket = randomBytes(32).toString('base64url');
    this.#entries.set(ticket, {
      scenarioId,
      expiresAt: this.#options.now() + this.#options.ttlMs,
    });
    return { ticket, expiresInMs: this.#options.ttlMs };
  }

  /**
   * True once for a ticket that was issued for `scenarioId` and has not expired; the ticket is
   * gone either way.
   */
  redeem(ticket: string, scenarioId: string): boolean {
    this.#purge();
    const entry = this.#entries.get(ticket);
    this.#entries.delete(ticket);
    return entry?.scenarioId === scenarioId;
  }

  /** Drops every ticket (the token was rotated: what it vouched for is no longer vouched for). */
  clear(): void {
    this.#entries.clear();
  }

  #purge(): void {
    const now = this.#options.now();
    for (const [ticket, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(ticket);
    }
  }
}
