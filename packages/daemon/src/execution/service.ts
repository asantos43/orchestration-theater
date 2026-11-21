// SPDX-License-Identifier: MPL-2.0
import type {
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
import { reconcileAttempts, type AttemptResolver, type ReconcileReport } from './reconcile.js';
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
      logger: this.#options.logger,
    });
    return this.#reconciled;
  }

  /** Stops the attempts the way a restart does, then ends every adapter process. */
  async stop(): Promise<void> {
    await this.runner.stop();
    await this.#reconciled?.done;
    await this.pool.shutdown();
  }
}
