// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  LAUNCH_MARKER_ENV,
  supportsMarkerScan,
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
 * [proposta] (Phase 11, P3) The row is written BEFORE the process starts (no pid yet), and when the
 * launcher can scan for markers its id goes into the child's environment as `OT_LAUNCH_ID`; the pid
 * and the start instant are filled in right after. A daemon killed in between leaves a row without
 * a pid, and the reconciliation finds the process by the marker ({@link MarkerScanner}). The id is
 * therefore unique per launch (`proc-<uuid>`) and no longer carries the pid.
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
    // The row comes first (Phase 11, P3, docs/23): a daemon that dies after the process exists and
    // before its pid is written would leave an orphan nobody knows. With the row already there and
    // its id in the child's environment, the next start finds the process by that marker.
    const id = `proc-${randomUUID()}`;
    const scannable = supportsMarkerScan(this.#inner);
    const written = await this.#store.sessions
      .open({
        id,
        client: basename(opts.cmd),
        profile: TRACKED_PROFILE,
        pid: null,
        processStartedAt: null,
        state: 'active',
      })
      .then(
        () => true,
        (error: unknown) => {
          this.#notTracked(opts, error);
          return false;
        },
      );
    let process: LaunchedProcess;
    try {
      process = await this.#inner.launch(
        written && scannable ? { ...opts, env: { ...opts.env, [LAUNCH_MARKER_ENV]: id } } : opts,
      );
    } catch (error) {
      if (written) await this.#close(id);
      throw error;
    }
    if (!written) return process;
    const startedAt = supportsOrphanKill(this.#inner)
      ? await this.#inner.processStartedAt(process.pid).catch(() => undefined)
      : undefined;
    try {
      await this.#store.sessions.update(id, {
        pid: process.pid,
        processStartedAt: startedAt ?? this.#clock.now(),
      });
    } catch (error) {
      // The process is already running. With the marker the next start still finds it; without a
      // launcher that can scan for it, losing the pid only costs the orphan search.
      if (!scannable) this.#notTracked(opts, error, process.pid);
    }
    void process.exited.then(() => this.#close(id));
    return process;
  }

  async #close(id: string): Promise<void> {
    try {
      await this.#store.sessions.update(id, { state: 'closed' });
    } catch {
      // The store may be closed already (the daemon is stopping).
    }
  }

  #notTracked(opts: LaunchOptions, error: unknown, pid?: number): void {
    this.#logger.warn({ err: error, pid }, 'could not record a launched process');
    this.#situations?.record('recovery.notice', {
      kind: 'process_not_tracked',
      subject: situationText(basename(opts.cmd), 256),
      detail: situationText(error),
    });
  }
}
