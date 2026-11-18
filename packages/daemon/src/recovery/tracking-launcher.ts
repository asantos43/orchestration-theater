// SPDX-License-Identifier: MPL-2.0
import { basename } from 'node:path';
import {
  supportsOrphanKill,
  type Clock,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessLauncher,
  type Store,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import { situationText, type SituationSink } from '../situations.js';

/** [proposta] The `profile` of a row written for a launched process: the launcher knows no profile. */
export const TRACKED_PROFILE = 'launcher';

/** What the tracking needs from the store: the registry of sessions. */
export type TrackingStore = Pick<Store, 'sessions'>;

/**
 * A `ProcessLauncher` that writes down every process it launches in `sessions` (architecture 5.21:
 * "pid e instante de início de cada processo de cliente"), before the process is handed to the
 * caller, so a daemon that dies with `kill -9` leaves in the store what the next one needs to find
 * the orphans. The row is closed when the root process ends.
 *
 * [proposta] One row per PROCESS, not per ACP session: the launcher sees processes, and a shared
 * process hosts many sessions. The row has the executable's name as `client` and
 * {@link TRACKED_PROFILE} as `profile`; `clientSessionId` and `attemptId` stay empty.
 *
 * The start instant is what the operating system says ({@link OrphanReaper.processStartedAt}), not
 * the clock of the daemon, so the next daemon compares like with like. A launcher that cannot say
 * (no orphan capability) gets the instant of the clock: the row is still written, but nothing can
 * kill the process from it.
 */
export class TrackingLauncher implements ProcessLauncher {
  readonly id: ProcessLauncher['id'];
  readonly implements: ProcessLauncher['implements'];
  readonly #inner: ProcessLauncher;
  readonly #store: TrackingStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #situations: SituationSink | undefined;

  constructor(
    inner: ProcessLauncher,
    store: TrackingStore,
    clock: Clock,
    logger: Logger,
    situations?: SituationSink,
  ) {
    this.#inner = inner;
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
    this.#situations = situations;
    this.id = inner.id;
    this.implements = inner.implements;
  }

  capabilities(): LauncherCapabilities {
    return this.#inner.capabilities();
  }

  async launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    const process = await this.#inner.launch(opts);
    const startedAt = supportsOrphanKill(this.#inner)
      ? await this.#inner.processStartedAt(process.pid).catch(() => undefined)
      : undefined;
    const id = `proc-${String(process.pid)}-${String(startedAt ?? this.#clock.now())}`;
    try {
      await this.#store.sessions.open({
        id,
        client: basename(opts.cmd),
        profile: TRACKED_PROFILE,
        pid: process.pid,
        processStartedAt: startedAt ?? this.#clock.now(),
        state: 'active',
      });
    } catch (error) {
      // The process is already running; losing its row only costs the orphan search next time.
      this.#logger.warn({ err: error, pid: process.pid }, 'could not record a launched process');
      this.#situations?.record('recovery.notice', {
        kind: 'process_not_tracked',
        subject: situationText(basename(opts.cmd), 256),
        detail: situationText(error),
      });
      return process;
    }
    void process.exited.then(async () => {
      try {
        await this.#store.sessions.update(id, { state: 'closed' });
      } catch {
        // The store may be closed already (the daemon is stopping).
      }
    });
    return process;
  }
}
