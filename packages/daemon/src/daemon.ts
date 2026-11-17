// SPDX-License-Identifier: MPL-2.0
import { homedir } from 'node:os';
import {
  AdapterUnavailable,
  hasErrorCode,
  hasStoreMaintenance,
  isLockableSecretVault,
  PermissionDenied,
  assertValidPrompts,
  type Clock,
  type LockableSecretVault,
  type PromptSource,
  type Registries,
  type RegistryEntries,
  type Secret,
  type SecretVault,
  type Store,
} from '@otheater/core';
import {
  buildDaemonEvent,
  DaemonStatusSchema,
  type BackupTrigger,
  type DaemonRecoveredPayload,
  type DaemonState,
  type DaemonStatus,
} from '@otheater/protocol';
import type { ClientFactory, ClientFactoryParts } from './clients.js';
import {
  compose,
  productionClients,
  type ComposeOverrides,
  type Composition,
  type ProductionClientsOptions,
} from './compose.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { Execution } from './execution/service.js';
import type { AttemptResolver } from './execution/reconcile.js';
import { executionSettingsOf } from './execution/settings.js';
import { InstanceLock } from './instance-lock.js';
import type { Logger } from './logger.js';
import type { McpAccess } from './mcp/access.js';
import { DirectiveService, registerDirectiveTools } from './directives/index.js';
import { ToolHandlers } from './mcp/handlers.js';
import { registerBrowserTools, secretPathCheck, type BrowserTools } from './browser/index.js';
import { nodePathHost, registerWorkTools, type ToolsDeps } from './tools/index.js';
import { registerReadTools } from './mcp/read-tools.js';
import { FrameworkMcpServer } from './mcp/server.js';
import { OrchestrationHandlers } from './orchestration/handlers.js';
import { ScenarioHandlers } from './scenarios/handlers.js';
import { startOrchestration, type Orchestration } from './orchestration/wiring.js';
import type { ProducerChannel } from './orchestration/channel.js';
import { dataPaths, ensureDataDir } from './paths.js';
import { defaultPromptSource } from './prompts.js';
import { buildDaemonRegistries } from './registries.js';
import { BackupService, type BackupOutcome } from './recovery/backup.js';
import { RecoveryGate } from './recovery/gate.js';
import { announceRecovery } from './recovery/notice.js';
import { reconcileBeforeResume, type RecoveryReport } from './recovery/reconcile.js';
import { BackupScheduler, type ActivityProbe } from './recovery/schedule.js';
import { TrackingLauncher } from './recovery/tracking-launcher.js';
import { packageVersion } from './version.js';

/** How many times the master password is asked before the daemon gives up. */
export const MAX_PASSWORD_ATTEMPTS = 3;

export interface PasswordRequest {
  /** 1-based. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * Asks the user for the vault master password. It is injected, so the daemon itself never touches
 * a terminal: the CLI passes a TTY prompt, tests pass a function. Returning `undefined` means "no
 * password available" (no terminal, the user gave up): the vault then stays locked.
 */
export type PasswordPrompt = (request: PasswordRequest) => Promise<Secret | undefined>;

export type { ActivityProbe };

export type { ClientFactory, ClientFactoryParts };

export interface StartDaemonOptions {
  readonly dataDir: string;
  /** Already validated configuration; when absent, `<data>/config.yaml` is read (missing file = defaults). */
  readonly config?: DaemonConfig | undefined;
  /** Instances that replace configured adapters (tests: `InMemoryStore`, `FakeClock`...). */
  readonly overrides?: ComposeOverrides | undefined;
  readonly passwordPrompt?: PasswordPrompt | undefined;
  /** Aborting it stops the daemon with the reason `signal`. */
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  readonly version?: string | undefined;
  readonly activityProbe?: ActivityProbe | undefined;
  /**
   * The clients that run attempts. Without it the daemon builds the ones `clients.*` of the config
   * turns on (`productionClients`); when none is on, it starts with the execution off.
   */
  readonly clients?: ClientFactory | undefined;
  /** Environment and executable search of the default factory (tests: no real `PATH`). */
  readonly clientSearch?: ProductionClientsOptions | undefined;
  /**
   * Tells the reconciliation what it needs to resume an attempt the daemon did not start (profile,
   * Executor, policy). Without it, the attempts that were running are parked as `interrupted`.
   */
  readonly resolveAttempt?: AttemptResolver | undefined;
  /**
   * The entries the registries are built from (roles, tools, rule keys, event types, flows,
   * scenario types). Without it the daemon uses the official ones. Tests hand in an invalid set to
   * check that the daemon refuses to start. [proposta]
   */
  readonly registries?: RegistryEntries | undefined;
  /**
   * What runs when a framework tool without a built-in handler is called (the blackboard, orders
   * and chat steps register theirs). Without it those tools answer `not_implemented`. [proposta]
   */
  readonly mcpHandlers?: ToolHandlers | undefined;
  /**
   * Where the role prompts come from. Without it the daemon uses the source `adapters.prompts`
   * asks for (the repository folder `prompts/`, or `prompts.directory`). Tests hand in a source with a bad
   * prompt to check that the daemon refuses to start. [proposta]
   */
  readonly prompts?: PromptSource | undefined;
}

export type StopReason = 'signal' | 'shutdown' | 'error';

export interface DaemonHandle {
  readonly clock: Clock;
  readonly store: Store;
  readonly vault: SecretVault;
  /** The validated registries the daemon started with (architecture 5.18). */
  readonly registries: Registries;
  /** Which adapter of each port is running (what `daemon.started` recorded). */
  readonly adapters: Composition['adapters'];
  /** Whether the vault is open now (a vault without a master password is always open). */
  readonly vaultLocked: boolean;
  /** The execution of attempts; `undefined` when no clients were given or there is no launcher. */
  readonly execution: Execution | undefined;
  /**
   * `http://127.0.0.1:<port>/mcp`: where the framework MCP server listens, with the port it got
   * (`mcp.port: auto` takes a free one at each start). Handed to the sessions of the attempts.
   */
  readonly mcpUrl: string;
  /**
   * The Producer's side (what `ot chat` reaches over `channel.json`): open a chat, send messages,
   * read the Director's replies, answer its questions. `undefined` when the execution is off.
   */
  readonly producer: ProducerChannel | undefined;
  /** The orders (architecture 5.17): what is in force, the drafts and the rules. */
  readonly directives: DirectiveService;
  status(): DaemonStatus;
  /** One backup now, queued behind any running one. Rejects when the store cannot make copies. */
  backup(trigger?: BackupTrigger): Promise<BackupOutcome>;
  /** Idempotent: every call returns the same promise. */
  stop(reason?: StopReason): Promise<void>;
  /** Resolves once the daemon has stopped, by any cause. */
  readonly stopped: Promise<void>;
}

/**
 * Starts the daemon (architecture 5.1, 5.18, 5.21). Order, and why:
 * 1. data directory and the **instance lock** first: a second daemon must never open the store;
 * 2. configuration; the registries are built and validated (a problem stops the start-up, naming
 *    the entry); then `compose` (the only place that names adapters), which opens the store;
 * 3. the lock info is published (pid, start, version) for the "already running" message;
 * 4. state `recovering`: `PRAGMA quick_check` on the store. The daemon refuses to start on a
 *    damaged store and says how to restore (full reconciliation of runs is not built yet);
 * 5. the vault is unlocked with the injected prompt, if it has a master password;
 * 6. `daemon.started` is appended to the log;
 * 7. the orders catch up with the clock (what started or ended while the daemon was stopped gets
 *    its event with the real boundary time) before any session opens, and their watcher starts;
 * 8. the reconciliation (5.21), while the MCP server and the Producer channel hold their calls:
 *    the client processes the dead daemon left are ended (pid and start instant), its sessions
 *    become `interrupted`, what its worktrees held uncommitted becomes a `wip(recovery)` commit,
 *    and the effects with an intent and no end are settled by their verifiers (or the Producer is
 *    asked); then the execution of attempts is built (when clients were given) and reconciles the
 *    attempts the previous daemon left running (each resumed with `session/load`, or parked), the
 *    plays are restored from their snapshots, `daemon.recovered` is written and the calls go on;
 * 9. the backup scheduler starts (only if the store can make copies);
 * 10. state `running`.
 * Any failure after step 1 releases everything taken so far and rejects.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const paths = dataPaths(options.dataDir);
  const version = options.version ?? packageVersion();
  await ensureDataDir(paths.dataDir);
  const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);

  let composition: Composition | undefined;
  let mcp: FrameworkMcpServer | undefined;
  let directives: DirectiveService | undefined;
  let browserTools: BrowserTools | undefined;
  // Closed until the reconciliation of the start-up ends: calls to the MCP server and to the
  // Producer channel wait here (5.21: "os comandos que mudam estado esperam").
  const gate = new RecoveryGate();
  try {
    const config = options.config ?? (await loadConfig(paths.config));
    // Registries first, before the store is opened: an invalid entry stops the start-up here.
    const registries = buildDaemonRegistries(options.registries);
    // P11: a prompt that cites a tool its role cannot call stops the start-up here too.
    const prompts = options.prompts ?? defaultPromptSource(config, paths.dataDir);
    await assertValidPrompts(prompts, registries);
    composition = await compose(config, {
      dataDir: paths.dataDir,
      events: { registry: registries.events, unknownType: config.events.unknown_type },
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const orchestrationHandlers = new OrchestrationHandlers();
    const scenarioHandlers = new ScenarioHandlers();
    // The framework MCP server (5.3) lives and dies with the daemon: a port that cannot be taken
    // (`mcp.port` fixed and busy) stops the start-up like any other adapter that is not there.
    // The orders (5.17): the tools of the Director come from here, unless the caller already
    // handed in its own handlers for them.
    directives = new DirectiveService({
      store: composition.store,
      clock: composition.clock,
      ruleKeys: registries.ruleKeys,
      settings: {
        timezone: config.directives.timezone,
        expiringNoticeMs: config.directives.expiring_notice,
      },
      logger: composition.logger,
    });
    const handlers = options.mcpHandlers ?? new ToolHandlers();
    if (!handlers.has('propose_directive')) {
      registerDirectiveTools(handlers, directives, composition.store);
    }
    const workDeps: ToolsDeps = {
      store: composition.store,
      config: config.tools,
      // The commands are processes too: they are written down like the clients' (5.21).
      launcher:
        composition.launcher === undefined
          ? undefined
          : new TrackingLauncher(
              composition.launcher,
              composition.store,
              composition.clock,
              composition.logger,
            ),
      vcs: composition.vcs,
      codeHost: composition.codeHost,
      confine: composition.sandbox?.confineCommand,
      clock: composition.clock,
      env: options.clientSearch?.env ?? process.env,
      host: nodePathHost(),
      logger: composition.logger,
    };
    // P6 (5.19): the browser tools. A write asks the Producer through the chat prompt queue;
    // `isSecret` is the one list of `security.secret_paths` (P4), the same the Sandbox uses.
    if (composition.browser !== undefined) {
      browserTools = registerBrowserTools(handlers, {
        ...workDeps,
        browser: config.browser,
        session: composition.browser,
        dataDir: paths.dataDir,
        isSecret: secretPathCheck(config, homedir(), paths.dataDir),
        askApproval: (scenarioId, input) => orchestrationHandlers.openApproval(scenarioId, input),
      });
      browserTools.startIdleLoop();
    }
    mcp = await FrameworkMcpServer.start({
      registries,
      port: config.mcp.port,
      submitRetries: config.limits.submit_retries,
      // The read tools (P7) are built in; a handler the caller already registered wins.
      // So are the tools of the Director that move a play (P8); their runtime is bound later.
      handlers: scenarioHandlers.register(
        orchestrationHandlers.register(
          registerWorkTools(registerReadTools(handlers, composition.store), workDeps),
        ),
      ),
      logger: composition.logger,
      version,
      gate,
    });
    return await run({
      options,
      config,
      composition,
      registries,
      mcp,
      browserTools,
      directives,
      lock,
      version,
      prompts,
      orchestrationHandlers,
      scenarioHandlers,
      gate,
    });
  } catch (error) {
    gate.open();
    await directives?.stop().catch(() => undefined);
    await mcp?.stop().catch(() => undefined);
    await browserTools?.close().catch(() => undefined);
    await composition?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

interface RunInput {
  readonly options: StartDaemonOptions;
  readonly config: DaemonConfig;
  readonly composition: Composition;
  readonly registries: Registries;
  readonly mcp: FrameworkMcpServer;
  readonly browserTools: BrowserTools | undefined;
  readonly directives: DirectiveService;
  readonly lock: InstanceLock;
  readonly version: string;
  readonly prompts: PromptSource;
  readonly orchestrationHandlers: OrchestrationHandlers;
  readonly scenarioHandlers: ScenarioHandlers;
  readonly gate: RecoveryGate;
}

async function run(input: RunInput): Promise<DaemonHandle> {
  const {
    options,
    config,
    composition,
    registries,
    mcp,
    browserTools,
    directives,
    lock,
    version,
    prompts,
    gate,
  } = input;
  const { clock, store, vault, logger } = composition;
  const paths = dataPaths(options.dataDir);
  const startedAt = clock.now();
  let state: DaemonState = 'starting';

  const status = (): DaemonStatus =>
    DaemonStatusSchema.parse({
      pid: process.pid,
      startedAt,
      version,
      dataDir: paths.dataDir,
      state,
    });

  await lock.publish({ pid: process.pid, startedAt, version });

  state = 'recovering';
  if (hasStoreMaintenance(store)) {
    const problems = await store.quickCheck();
    if (problems.length > 0) {
      logger.error({ problems: problems.slice(0, 5) }, 'store failed quick_check');
      throw new AdapterUnavailable(
        `The store failed its integrity check (${problems.slice(0, 3).join('; ')}). ` +
          `Restore a backup with "ot restore <backup folder>"; backups are in ${dataPaths(paths.dataDir).backups}.`,
      );
    }
  }

  if (isLockableSecretVault(vault)) {
    await unlockVault(vault, options.passwordPrompt, logger);
  }

  await store.events.append(
    buildDaemonEvent('daemon.started', {
      pid: process.pid,
      version,
      dataDir: paths.dataDir,
      adapters: {
        store: adapterRef(composition, 'Store', config.adapters.store),
        vault: adapterRef(composition, 'SecretVault', config.adapters.vault),
        clock: adapterRef(composition, 'Clock', config.adapters.clock),
      },
    }),
  );

  await directives.start();

  const recoveryStartedAt = clock.now();
  // Before anything is resumed: the orphans, the sessions, the worktrees and the effects (5.21).
  const recovery = await reconcileBeforeResume({
    store,
    vcs: composition.vcs,
    codeHost: composition.codeHost,
    launcher: composition.launcher,
    logger,
  });
  const execution = buildExecution(options, config, composition, paths.worktrees, mcp);
  let attemptsInterrupted = 0;
  let attempts: { resuming: readonly string[] } = { resuming: [] };
  if (execution !== undefined) {
    const report = await execution.reconcile();
    attemptsInterrupted = report.parked.length;
    attempts = { resuming: report.resuming };
    // The resumed attempts run on; nothing here waits for them.
    void report.done;
  }
  let orchestration: Orchestration | undefined;
  if (execution !== undefined) {
    // The plays: the queue, the Director sessions, the effects and the Producer channel (P8).
    orchestration = await startOrchestration({
      config,
      composition,
      execution,
      mcp,
      registries,
      prompts,
      paths,
      handlers: input.orchestrationHandlers,
      scenarioHandlers: input.scenarioHandlers,
      gate,
    });
  }
  // The machines of the plays come back from their snapshots; the orders were recomputed by
  // `directives.start()` above (it emits the transitions the stop made it miss).
  const resumed = (await orchestration?.runner.resumeAll()) ?? { resumed: [], refused: [] };
  await store.events.append(
    buildDaemonEvent(
      'daemon.recovered',
      recoveredPayload(recovery, resumed, {
        attemptsInterrupted,
        durationMs: Math.max(0, clock.now() - recoveryStartedAt),
      }),
    ),
  );
  // What the start-up did, for the chat of each scenario it touched (5.21, step 8); nothing when
  // there was nothing to settle. The record is the event; the channel hands it to the next poll.
  const notices = await announceRecovery({
    store,
    logger,
    mode: config.recovery.notice,
    recovery,
    plays: resumed,
    attempts,
  });
  for (const notice of notices) orchestration?.channel.notify(notice);
  gate.open();
  // The ideas of a group the restart lost go back to the queue, and the queues that can move do.
  await orchestration?.ideas.settle();

  const storeCanBackUp = hasStoreMaintenance(store);
  const service = new BackupService({
    dataDir: paths.dataDir,
    settings: config.backup,
    clock,
    logger,
    version,
    storeBackup: (dest, backupOptions) => {
      if (!hasStoreMaintenance(store)) {
        return Promise.reject(new AdapterUnavailable('This store cannot make backups'));
      }
      return store.backup(dest, backupOptions);
    },
    recordEvent: (event) => store.events.append(event),
  });
  const scheduler = new BackupScheduler({
    settings: config.backup,
    runner: service,
    clock,
    logger,
    activity: options.activityProbe,
  });
  if (storeCanBackUp) {
    scheduler.start();
  } else {
    logger.warn('this store has no backup support; scheduled backups are off');
  }

  state = 'running';
  logger.info({ version, dataDir: paths.dataDir }, 'daemon running');

  let stopping: Promise<void> | undefined;
  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  const onAbort = (): void => {
    void handle.stop('signal');
  };
  const stop = (reason: StopReason = 'shutdown'): Promise<void> =>
    (stopping ??= (async () => {
      state = 'stopping';
      options.signal?.removeEventListener('abort', onAbort);
      const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
        try {
          await step();
        } catch (error) {
          logger.error({ err: error }, `shutdown step failed: ${what}`);
        }
      };
      await attempt('scheduler', () => scheduler.stop());
      await attempt('orchestration', async () => orchestration?.quiesce());
      await attempt('directives', () => directives.stop());
      await attempt('execution', async () => execution?.stop());
      await attempt('effects', async () => orchestration?.drain());
      await attempt('mcp', () => mcp.stop());
      await attempt('browser', async () => browserTools?.close());
      await attempt('daemon.stopped', () =>
        store.events.append(
          buildDaemonEvent('daemon.stopped', {
            reason,
            uptimeMs: Math.max(0, clock.now() - startedAt),
          }),
        ),
      );
      await attempt('composition', () => composition.close());
      await attempt('lock', () => lock.release());
      markStopped();
    })());

  const handle: DaemonHandle = {
    clock,
    // The store as the adapter built it; the daemon's own code appends through the validated one.
    store: composition.rawStore,
    vault,
    registries,
    adapters: composition.adapters,
    execution,
    mcpUrl: mcp.url,
    producer: orchestration?.channel,
    directives,
    get vaultLocked() {
      return isLockableSecretVault(vault) && vault.isLocked;
    },
    status,
    backup: (trigger = 'manual') => {
      if (!storeCanBackUp) {
        return Promise.reject(new AdapterUnavailable('This store cannot make backups'));
      }
      return service.run(trigger);
    },
    stop,
    stopped,
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) void handle.stop('signal');
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  return handle;
}

function buildExecution(
  options: StartDaemonOptions,
  config: DaemonConfig,
  composition: Composition,
  worktreeRoot: string,
  mcp: McpAccess,
): Execution | undefined {
  const { logger } = composition;
  const { launcher: rawLauncher } = composition;
  if (rawLauncher === undefined) {
    logger.warn('this platform has no process launcher yet; the execution of attempts is off');
    return undefined;
  }
  // Every process the clients start is written down, so the next daemon can find the orphans (5.21).
  const launcher = new TrackingLauncher(rawLauncher, composition.store, composition.clock, logger);
  const factory = options.clients ?? productionClients(config, options.clientSearch);
  const clients = factory({
    launcher,
    clock: composition.clock,
    transport: composition.transport,
    paths: dataPaths(options.dataDir),
    logger,
    ...(composition.sandbox === undefined
      ? {}
      : {
          sandbox: {
            capabilities: composition.sandbox.capabilities,
            // The framework MCP server is the daemon's own loopback service the client must reach.
            launchWrapper: composition.sandbox.launchWrapper(() => [mcp.url]),
          },
        }),
  });
  if (clients.length === 0) {
    logger.warn(
      'no client is enabled (none configured or found in PATH); the execution of attempts is off',
    );
    return undefined;
  }
  return new Execution({
    clients,
    launcher,
    transport: () => composition.transport,
    store: composition.store,
    vcs: composition.vcs,
    clock: composition.clock,
    settings: executionSettingsOf(config),
    worktreeRoot,
    logger,
    mcp,
    ...(options.resolveAttempt === undefined ? {} : { resolver: options.resolveAttempt }),
  });
}

function recoveredPayload(
  recovery: RecoveryReport,
  plays: { resumed: string[]; refused: string[] },
  extra: { attemptsInterrupted: number; durationMs: number },
): DaemonRecoveredPayload {
  return {
    durationMs: extra.durationMs,
    orphansKilled: recovery.orphansKilled,
    sessionsInterrupted: recovery.sessionsInterrupted,
    attemptsInterrupted: extra.attemptsInterrupted,
    wipCommits: recovery.wipCommits,
    effectsResolved: recovery.effectsResolved,
    playsResumed: plays.resumed,
    playsRefused: plays.refused,
    pending: recovery.pending.map((item) => ({
      kind: 'effect' as const,
      key: item.key,
      effectType: item.effectType,
      playId: item.playId,
      reason: item.reason,
    })),
  };
}

function adapterRef(
  composition: Composition,
  port: 'Store' | 'SecretVault' | 'Clock',
  configured: string,
): { id: string; portVersion: string } {
  const record = composition.adapters.find((adapter) => adapter.port === port);
  return {
    id: record?.id === 'override' ? 'override' : configured,
    portVersion: record?.portVersion ?? 'unknown',
  };
}

/**
 * [proposta] The master password flow: up to {@link MAX_PASSWORD_ATTEMPTS} tries through the
 * prompt; a wrong password (`PermissionDenied`) asks again and, after the last try, rejects so the
 * daemon does not start. With no prompt, or a prompt that answers `undefined`, the daemon starts
 * with the vault locked and a warning: what needs secrets fails later with `VaultLocked`.
 */
async function unlockVault(
  vault: LockableSecretVault,
  prompt: PasswordPrompt | undefined,
  logger: Logger,
): Promise<void> {
  if (!vault.isLocked) return;
  if (prompt === undefined) {
    logger.warn('the vault is locked and no password prompt is available; it stays locked');
    return;
  }
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
    const password = await prompt({ attempt, maxAttempts: MAX_PASSWORD_ATTEMPTS });
    if (password === undefined) {
      logger.warn('no master password given; the vault stays locked');
      return;
    }
    try {
      await vault.unlock(password);
      logger.info('vault unlocked');
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'PERMISSION_DENIED')) throw error;
      logger.warn({ attempt }, 'wrong master password');
    }
  }
  throw new PermissionDenied(
    `Wrong master password ${String(MAX_PASSWORD_ATTEMPTS)} times; the daemon was not started`,
  );
}
