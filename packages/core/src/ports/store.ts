// SPDX-License-Identifier: MPL-2.0
import type { AttemptRegistry } from './attempt-registry.js';
import type { Blackboard } from './blackboard.js';
import type { DirectiveRegistry } from './directives.js';
import type { EventLog } from './event-log.js';
import type { ExecutorRegistry } from './executor-records.js';
import type { IdeaRegistry } from './ideas.js';
import type { InterruptionRegistry } from './interruptions.js';
import type { DecisionRegistry, DemandRegistry, PlayRegistry, StageRegistry } from './plays.js';
import type { ProfileRegistry } from './profiles.js';
import type { PromptQueue } from './prompt-queue.js';
import type { QuotaSnapshotRegistry } from './quota-snapshots.js';
import type { AttachmentRegistry, ScenarioRegistry, ScenarioRepoRegistry } from './scenarios.js';
import type { SessionRegistry } from './sessions.js';
import type { SideEffectRegistry } from './side-effects.js';
import type { UsageRegistry } from './usage.js';
import type { SetupRunRegistry } from './setup-runs.js';
import type { WakeupRegistry } from './wakeups.js';
import type { WorkflowBindingRegistry, WorkflowDefinitionRegistry } from './workflows.js';

/**
 * Semver of the `Store` port contract.
 *
 * - 0.2.0 added the attempt registry (`attempts`); a 0.x minor bump is a contract change.
 * - 0.3.0 added the aggregates of Phase 3 ({@link StoreAggregates}): scenarios, plays, stages,
 *   demands, decisions, the blackboard, the prompt queue, side effects, sessions and directives.
 * - 0.4.0 added the idea queue of the scenario (`ideas`, Phase 4, architecture 5.20).
 * - 0.5.0 added the tables of Phase 5 (section 7): `profiles`, `executors`, `interruptions`,
 *   `quotaSnapshots`, `usage` and `wakeups`.
 * - 0.6.0 (N177) gave a transaction one instant: `tx.now()`, and the records and events it writes
 *   carry that same reading of the clock.
 * - 0.7.0 added the runs of the setup assistant (`setupRuns`, Phase 7, 5.7).
 * - 0.8.0 put a typed error in the contract: a write the disk has no room for fails with `DiskFull`
 *   (`DISK_FULL`), with nothing of it kept (Phase 11, P5, N279).
 * - 0.9.0 added the workflow library and the bindings of the scenarios (`workflowDefinitions`,
 *   `workflowBindings`, Phase 11b, P5, N296).
 */
export const STORE_PORT_VERSION = '0.9.0';

/**
 * The aggregates of the store (architecture section 7), one registry per table. [proposta] Each
 * one is available in a transaction (`tx.plays`) and outside it (`store.plays`), with the rules
 * described at {@link Store}; every contract is checked by its `describe*Conformance` suite.
 * `task_definitions` and `task_runs` join when the tasks do (5.20).
 */
export interface StoreAggregates {
  readonly scenarios: ScenarioRegistry;
  readonly scenarioRepos: ScenarioRepoRegistry;
  readonly attachments: AttachmentRegistry;
  readonly plays: PlayRegistry;
  readonly stages: StageRegistry;
  readonly demands: DemandRegistry;
  readonly decisions: DecisionRegistry;
  readonly blackboard: Blackboard;
  readonly promptQueue: PromptQueue;
  readonly sideEffects: SideEffectRegistry;
  readonly sessions: SessionRegistry;
  readonly directives: DirectiveRegistry;
  readonly ideas: IdeaRegistry;
  readonly profiles: ProfileRegistry;
  readonly executors: ExecutorRegistry;
  readonly interruptions: InterruptionRegistry;
  readonly quotaSnapshots: QuotaSnapshotRegistry;
  readonly usage: UsageRegistry;
  readonly wakeups: WakeupRegistry;
  readonly setupRuns: SetupRunRegistry;
  readonly workflowDefinitions: WorkflowDefinitionRegistry;
  readonly workflowBindings: WorkflowBindingRegistry;
}

/**
 * What a transaction body can touch: the event log, the attempt registry and the aggregates, so
 * the domain can change state and record the event in one atomic step.
 */
export interface StoreTransaction extends StoreAggregates {
  readonly events: EventLog;
  readonly attempts: AttemptRegistry;
  /**
   * The instant of the transaction (epoch ms): the clock is read once, the first time anything in
   * the transaction needs a stamp, and every record (`createdAt`, `updatedAt`, `finishedAt`...) and
   * every event written through `tx` carries that same reading. [proposta] N177: a caller that
   * must stamp a field of its own (`finishedAt` of a play) asks here, so the record and the event
   * of one change never differ by the ticks of a clock that moves.
   */
  now(): number;
}

/**
 * Persistence and transactions (architecture 5.18 and section 7). The rest of the daemon never
 * sees SQL: the default adapter is SQLite + Kysely (step 4), the test adapter is in memory.
 *
 * Contract (checked by `describeStoreConformance` in `@otheater/sdk`):
 * - `transaction(fn)` commits when `fn` resolves and returns its value. When `fn` rejects it rolls
 *   back everything done through `tx` and rethrows **the same error object** (typed errors cross
 *   the port untouched).
 * - Transactions are serialized, in call order: the body of one never runs concurrently with
 *   another. There is no nesting: the `tx` handle has no `transaction` method.
 * - Read-your-writes inside `fn`; outside it, only committed data is visible, and a transaction
 *   becomes visible all at once (never half of its events).
 * - Using `tx` after `fn` settled is a programming error and rejects with `Conflict`.
 * - `events`, `attempts` and the aggregates are the same resources outside a transaction: each
 *   call that writes there is its own transaction, and a read sees only committed data (it never
 *   waits for a transaction in progress).
 * - After `close()` every operation rejects with `AdapterUnavailable`; `close()` is idempotent and
 *   waits for the transaction in flight.
 */
export interface Store extends StoreAggregates {
  readonly events: EventLog;
  readonly attempts: AttemptRegistry;

  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Outcome of {@link StoreMaintenance.backup}, neutral about the adapter. [proposta] The shape is
 * what the SQLite adapter already reports, so the daemon can log and record it without knowing
 * which store made the copy.
 */
export interface StoreBackupResult {
  /** Absolute path of the finished copy. */
  readonly path: string;
  readonly bytes: number;
  /** Name of the method the adapter used (`online_api`, `vacuum_into`...). */
  readonly method: string;
  readonly durationMs: number;
  /** Times an online copy started over because the store changed under it (0 when none). */
  readonly restarts: number;
}

/** Options of {@link StoreMaintenance.backup}; every adapter documents the names it accepts. */
export interface StoreBackupOptions {
  /** Adapter-specific method name. An unknown name rejects with `InvalidInput`. */
  readonly method?: string;
  /**
   * Adapter-specific: pages copied per step by an online copy. Omitted means the adapter's own
   * default (the SQLite adapter copies everything in one step). An adapter or method without
   * steps ignores it.
   */
  readonly pagesPerStep?: number;
}

/**
 * Optional capability of a `Store`: maintenance that only a real database offers (architecture
 * 5.21). It is **not** part of the `Store` port, so `STORE_PORT_VERSION` does not change and the
 * in-memory store simply does not have it. The daemon asks with {@link hasStoreMaintenance}.
 *
 * - `quickCheck()` is the cheap integrity check of start-up. It resolves with the problems found;
 *   an empty array means the check passed.
 * - `backup(dest)` makes a consistent copy of the store **while it is in use**, checks the copy
 *   (a failed check rejects and leaves nothing at `dest`), and refuses to overwrite (`Conflict`).
 *
 * Both reject with `AdapterUnavailable` after `close()`.
 */
export interface StoreMaintenance {
  quickCheck(): Promise<string[]>;
  backup(dest: string, options?: StoreBackupOptions): Promise<StoreBackupResult>;
}

/** Type guard for the optional {@link StoreMaintenance} capability of a store. */
export function hasStoreMaintenance(store: Store): store is Store & StoreMaintenance {
  const candidate = store as Partial<Record<keyof StoreMaintenance, unknown>>;
  return typeof candidate.quickCheck === 'function' && typeof candidate.backup === 'function';
}
