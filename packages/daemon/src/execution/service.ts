// SPDX-License-Identifier: MPL-2.0
import { FINAL_PLAY_STATES } from '@otheater/protocol';
import type {
  AttemptRecord,
  ClientAdapter,
  Clock,
  MemoryProbe,
  ProcessLauncher,
  SessionTransport,
  Store,
  Vcs,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import type { WaitTracker } from '../telemetry/wait-events.js';
import type { McpAccess } from '../mcp/access.js';
import type { CanAdmit, LocalInstanceResolver } from './admission.js';
import { AttemptRunner, type AttemptRunnerOptions } from './attempt-runner.js';
import type { ExhaustionPort } from './exhaustion.js';
import type { HandoffPort } from './handoff.js';
import { SessionPool } from './pool.js';
import type { SessionTelemetry } from '../telemetry/client-telemetry.js';
import {
  parkAttempt,
  reconcileAttempts,
  type AttemptResolver,
  type ReconcileReport,
} from './reconcile.js';
import type { ExecutionSettings } from './settings.js';

export interface ExecutionOptions {
  readonly clients: readonly ClientAdapter[];
  readonly launcher: ProcessLauncher;
  readonly transport: (adapter: ClientAdapter) => SessionTransport;
  readonly store: Store;
  readonly vcs: Vcs;
  readonly clock: Clock;
  readonly settings: ExecutionSettings;
  readonly worktreeRoot: string;
  readonly logger: Logger;
  /** Who knows the roles: lets the reconciliation resume attempts it did not start. */
  readonly resolver?: AttemptResolver;
  /** The framework MCP server, which hands each attempt's session its tools (5.3). */
  readonly mcp?: McpAccess;
  /** The quota of the profiles: a limit error of a session goes to it (P17, 5.16). */
  readonly quota?: AttemptRunnerOptions['quota'];
  /** What the roles and the budget say when a profile runs out (P19): the wait for the reset needs it. */
  readonly exhaustion?: ExhaustionPort;
  /** Free RAM for the admission of `pool.admission.mode: ram | ram_and_quota`. */
  readonly memory?: MemoryProbe;
  /** The quota hook of `ram_and_quota`; P15 wires it to the `QuotaService`. Default: always yes. */
  readonly canAdmit?: CanAdmit;
  /** The local instance behind a profile: its `slots` are the vacancies of that profile. */
  readonly localInstance?: LocalInstanceResolver;
  /** Who writes the events of the waits of the pool (P15, N222 (a)); absent when they are off. */
  readonly waits?: WaitTracker;
  /** The baton of an attempt (P18): the next Executor and the package. Without it a handoff parks. */
  readonly handoff?: HandoffPort;
  /** Where the clients send their telemetry (P2); absent: the sessions start with none. */
  readonly telemetry?: SessionTelemetry;
}

/**
 * The execution of attempts in the daemon: the session pool, the runner of attempts and the
 * reconciliation at start. The daemon builds it when it has a process launcher and clients.
 */
export class Execution {
  readonly pool: SessionPool;
  readonly runner: AttemptRunner;
  readonly #options: ExecutionOptions;
  #reconciled: ReconcileReport | undefined;
  /** `resume.on_restart: native`: the attempts kept for their plays, by id, until claimed. */
  readonly #deferred = new Map<string, AttemptRecord>();

  constructor(options: ExecutionOptions) {
    this.#options = options;
    this.pool = new SessionPool({
      clients: options.clients,
      launcher: options.launcher,
      transport: options.transport,
      clock: options.clock,
      settings: options.settings.pool,
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.canAdmit === undefined ? {} : { canAdmit: options.canAdmit }),
      ...(options.localInstance === undefined ? {} : { localInstance: options.localInstance }),
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
      ...(options.waits === undefined ? {} : { waits: options.waits }),
    });
    this.runner = new AttemptRunner({
      store: options.store,
      vcs: options.vcs,
      pool: this.pool,
      clock: options.clock,
      settings: options.settings,
      worktreeRoot: options.worktreeRoot,
      logger: options.logger,
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.quota === undefined ? {} : { quota: options.quota }),
      ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
      ...(options.exhaustion === undefined ? {} : { exhaustion: options.exhaustion }),
    });
  }

  /** What the last reconciliation found and started, once `reconcile()` ran. */
  get reconciled(): ReconcileReport | undefined {
    return this.#reconciled;
  }

  /** Resumes what the previous daemon left running. Call once, before taking new attempts. */
  async reconcile(): Promise<ReconcileReport> {
    this.#reconciled = await reconcileAttempts({
      store: this.#options.store,
      runner: this.runner,
      resolver: this.#options.resolver,
      ...(this.#options.settings.onRestart === 'native' ? { defer: (r) => this.#keeps(r) } : {}),
      logger: this.#options.logger,
    });
    for (const record of this.#reconciled.deferred) this.#deferred.set(record.attemptId, record);
    return this.#reconciled;
  }

  /**
   * `resume.on_restart: native`: an attempt that was running (or stopped for the restart) with a
   * conversation, in a play that is still going, waits for its play. Waits for a reset (P19) and a
   * removed profile (P21b) keep their own way.
   */
  async #keeps(record: AttemptRecord): Promise<boolean> {
    if (record.sessionId === null) return false;
    if (record.state === 'awaiting_resume' && record.cause !== 'daemon_restart') return false;
    const play = await this.#options.store.plays.get(record.playId);
    return play !== undefined && !(FINAL_PLAY_STATES as readonly string[]).includes(play.state);
  }

  /**
   * The attempt of a demand of a play that the reconciliation kept for it (`resume.on_restart:
   * native`), handed over once: the newest one. The caller resumes it (`runner.resume`) or gives
   * it back with {@link releaseDeferred}.
   */
  claimDeferred(playId: string, demandId: string): AttemptRecord | undefined {
    const mine = [...this.#deferred.values()]
      .filter((record) => record.playId === playId && record.demandId === demandId)
      .sort((a, b) => b.attempt - a.attempt);
    const [newest, ...older] = mine;
    if (newest === undefined) return undefined;
    // Only the newest attempt of a demand can be running; older ones are left over: parked.
    for (const record of [newest, ...older]) this.#deferred.delete(record.attemptId);
    for (const record of older) void this.releaseDeferred(record, 'resume:superseded');
    return newest;
  }

  /**
   * Parks an attempt that was kept for its play and will not be resumed natively (another profile
   * took the role, the play was aborted): the way on is the handoff, as without `native`.
   */
  async releaseDeferred(record: AttemptRecord, signal: string): Promise<void> {
    this.#deferred.delete(record.attemptId);
    try {
      await parkAttempt(this.#options.store, record, {
        signal,
        detail: 'the daemon was not running and the attempt could not be resumed in its session',
      });
    } catch (error) {
      this.#options.logger.error(
        { err: error, attemptId: record.attemptId },
        'parking a kept attempt failed',
      );
    }
  }

  /** Parks every attempt still kept for a play (`abort_work`). */
  async releaseDeferredOf(playId: string, signal: string): Promise<void> {
    const mine = [...this.#deferred.values()].filter((record) => record.playId === playId);
    for (const record of mine) await this.releaseDeferred(record, signal);
  }

  /** The attempts still kept for their plays (the status and the tests read it). */
  get deferred(): readonly AttemptRecord[] {
    return [...this.#deferred.values()];
  }

  /** Stops the attempts the way a restart does, then ends every adapter process. */
  async stop(): Promise<void> {
    await this.runner.stop();
    await this.#reconciled?.done;
    await this.pool.shutdown();
  }
}
