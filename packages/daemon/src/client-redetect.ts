// SPDX-License-Identifier: MPL-2.0
import type { ClientAdapter } from '@otheater/core';
import type { ClientSelection, ClientSelectionReason } from './clients.js';
import { CLIENT_IDS, type ClientId } from './config.js';
import type { Logger } from './logger.js';
import { situationSubject, situationText, type SituationSink } from './situations.js';

/**
 * What started a search (P18, N321): `open` (the setup assistant opened or started a run, or an
 * account is being added; only with `clients.detection.redetect: auto`) or `asked` (the R key).
 */
export type ClientRedetectTrigger = 'open' | 'asked';

/** What one search for the clients did. */
export interface RedetectResult {
  /** The clients this search added to the pool, in the order of `CLIENT_IDS`. */
  readonly added: readonly ClientId[];
}

export interface ClientRedetectorOptions {
  /** The pool of the execution: what it has, and where a new client goes. */
  readonly pool: {
    has(client: string): boolean;
    addClient(adapter: ClientAdapter): void;
  };
  /**
   * Builds the clients that are not in `skip`, with the environment read again (on Windows, the
   * `Path` of the registry). `report` takes the choice of each client looked at.
   */
  readonly build: (
    skip: ReadonlySet<ClientId>,
    report: (selections: readonly ClientSelection[]) => void,
  ) => Promise<readonly ClientAdapter[]>;
  /** Taps a new adapter (quota signals) and wires its quota probe; the pool takes what it returns. */
  readonly wire: (adapter: ClientAdapter) => Promise<ClientAdapter>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly situations?: SituationSink | undefined;
}

/**
 * Looks for the clients again without a restart (P18, N321): a client installed after the daemon
 * started, or found only in the `Path` of the Windows registry, enters the pool. A client the pool
 * has stays as it is (a client that is gone is seen at the next start). Calls that come together
 * share one search. It also keeps why each client was left out, for the setup assistant.
 */
export class ClientRedetector {
  readonly #o: ClientRedetectorOptions;
  readonly #reasons = new Map<ClientId, ClientSelectionReason>();
  #running: Promise<RedetectResult> | undefined;

  constructor(options: ClientRedetectorOptions) {
    this.#o = options;
  }

  /** Writes down the choice of each client (the first build, at the start, tells it here too). */
  note(selections: readonly ClientSelection[]): void {
    for (const selection of selections) this.#reasons.set(selection.id, selection.reason);
  }

  /** Why the last search left a client out (or put it on); `undefined` when no build looked at it. */
  reasonOf(client: string): ClientSelectionReason | undefined {
    return this.#reasons.get(client as ClientId);
  }

  redetect(): Promise<RedetectResult> {
    this.#running ??= this.#search().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #search(): Promise<RedetectResult> {
    const { pool, logger } = this.#o;
    const skip = new Set(CLIENT_IDS.filter((client) => pool.has(client)));
    if (skip.size === CLIENT_IDS.length) return { added: [] };
    const selections = new Map<ClientId, ClientSelection>();
    const built = await this.#o.build(skip, (list) => {
      this.note(list);
      for (const selection of list) selections.set(selection.id, selection);
    });
    const added: ClientId[] = [];
    for (const adapter of built) {
      const id = adapter.id as ClientId;
      // A factory that does not read `skip` builds the clients the pool has: they are dropped.
      if (pool.has(id) || !(CLIENT_IDS as readonly string[]).includes(id)) continue;
      pool.addClient(await this.#o.wire(adapter));
      added.push(id);
      const reason = selections.get(id)?.reason;
      // The assistant reads the pool: a client in it is on, whatever the build said before.
      if (reason !== undefined) this.#reasons.set(id, reason);
      logger.info({ client: id, reason }, 'client found after the start; added to the pool');
      this.#o.situations?.record('daemon.notice', {
        kind: 'client_added',
        subject: situationSubject(id),
        detail: situationText(reason ?? null),
      });
    }
    added.sort((a, b) => CLIENT_IDS.indexOf(a) - CLIENT_IDS.indexOf(b));
    return { added };
  }
}
