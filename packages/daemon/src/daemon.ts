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
  type ProfileRef,
  type PromptSource,
  type Registries,
  type RegistryEntries,
  type Secret,
  type SecretVault,
  type Store,
} from '@otheater/core';
import {
  API_VERSION,
  buildDaemonEvent,
  DaemonStatusSchema,
  type BackupTrigger,
  type DaemonId,
  type DaemonRecoveredPayload,
  type DaemonState,
  type DaemonStatus,
} from '@otheater/protocol';
import { loadOrCreateApiToken, loadOrCreateDaemonId } from './api/files.js';
import { registerChatRoutes } from './api/chat-socket.js';
import { registerEventRoutes } from './api/routes/events.js';
import { ApiServer } from './api/server.js';
import { AnalysisService } from './analysis/analysis-service.js';
import { AtifAutoExport } from './atif/atif-follower.js';
import { AtifExporter } from './atif/atif-exporter.js';
import { TrajectoryService } from './trajectory/service.js';
import { registerCommandRoutes, registerReadRoutes } from './api/routes/index.js';
import { detectSystemLocale, resolveLocale } from './i18n.js';
import { SlashCatalog, SlashCommandService } from './slash/index.js';
import { SetupService } from './setup/index.js';
import { buildClientEnv, type ClientFactory, type ClientFactoryParts } from './clients.js';
import {
  compose,
  productionClients,
  type ComposeOverrides,
  type Composition,
  type ProductionClientsOptions,
} from './compose.js';
import { CLIENT_IDS, loadConfig, type DaemonConfig } from './config.js';
import { createConfigReloader } from './config-reload.js';
import { Execution } from './execution/service.js';
import type { EventHub } from './events/event-hub.js';
import type { AttemptResolver } from './execution/reconcile.js';
import { executionSettingsOf } from './execution/settings.js';
import { InstanceLock } from './instance-lock.js';
import { LayoutPreferencesStore } from './layout/preferences.js';
import type { Logger } from './logger.js';
import type { McpAccess } from './mcp/access.js';
import { DirectiveService, registerDirectiveTools } from './directives/index.js';
import {
  QuotaService,
  quotaProbeOf,
  quotaSettingsOf,
  tapClient,
  WakeupManager,
  wakeupSettingsOf,
} from './quota/index.js';
import { BudgetService, budgetSettingsOf } from './budget/index.js';
import { UsageAudit, UsageService, usageAuditSettingsOf, usageSettingsOf } from './usage/index.js';
import { ToolHandlers } from './mcp/handlers.js';
import { registerBrowserTools, secretPathCheck, type BrowserTools } from './browser/index.js';
import { nodePathHost, registerWorkTools, type ToolsDeps } from './tools/index.js';
import { registerReadTools } from './mcp/read-tools.js';
import { FrameworkMcpServer } from './mcp/server.js';
import { exportsPrometheus } from './telemetry/export-config.js';
import { MetricsCollector } from './telemetry/metrics.js';
import { EventMetrics } from './telemetry/metrics-events.js';
import { startTelemetry, type TelemetryRuntime } from './telemetry/runtime.js';
import { OrchestrationHandlers } from './orchestration/handlers.js';
import { loadCrossCheckNotices } from './orchestration/cross-check-notices.js';
import { deprecationWarnings } from './orchestration/role-executors.js';
import { ScenarioHandlers } from './scenarios/handlers.js';
import { AttachmentService } from './scenarios/attachments.js';
import { DirectSessionService } from './direct/service.js';
import { ShellCommandService } from './shell/service.js';
import { createDaemonExhaustion } from './orchestration/exhaustion-wiring.js';
import { createLateHandoff } from './orchestration/handoff-wiring.js';
import { startOrchestration, type Orchestration } from './orchestration/wiring.js';
import { createLateExhaustion, type ExhaustionPort } from './execution/exhaustion.js';
import type { HandoffPort } from './execution/handoff.js';
import type { ProducerChannel } from './orchestration/channel.js';
import { dataPaths, ensureDataDir } from './paths.js';
import { situationSubject, situationText, type SituationSink } from './situations.js';
import { liveProfileSessions } from './profiles/live-sessions.js';
import { roleListsOf } from './profiles/role-lists.js';
import { profileSecretEnv } from './profiles/secret-env.js';
import { ExecutorService } from './executors/service.js';
import { ProfileLoginService } from './profiles/login.js';
import { ProfileService, profileSettingsOf } from './profiles/service.js';
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
  /**
   * P2 (Phase 6): the in-process notice of a new event. `eventHub.follow({ afterId, filter, signal })`
   * is the live read the SSE (P4) and the WebSocket (P7) use; `store` above already announces
   * through it.
   */
  readonly eventHub: EventHub;
  /**
   * P3 (Phase 6): the HTTP API of the daemon, listening on `127.0.0.1` since the start. `api.handlers`
   * is where P4 to P7 register the handler of each route of `API_ROUTES` (`api.handlers.register(id,
   * handler, { command })`); `api.url` is the base URL (no token); `api.onTokenRotated(listener)` is
   * the hook the streams and sockets close on when the token changes.
   */
  readonly api: ApiServer;
  /** The id of this daemon (N168): the UUID of `daemon-id` in the data folder, the same across restarts. */
  readonly daemonId: DaemonId;
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
   * `http://127.0.0.1:<port>`: where the OTLP receiver of the clients' telemetry listens (Phase 8,
   * P2), with the port it got. `undefined` when `telemetry.enabled` is `off` or it could not start.
   * The token is not here: only the sessions the daemon starts are given it.
   */
  readonly telemetryUrl: string | undefined;
  /**
   * The Producer's side (what the chat socket and the REST commands reach): open a chat, send messages,
   * read the Director's replies, answer its questions. `undefined` when the execution is off.
   */
  readonly producer: ProducerChannel | undefined;
  /** The orders (architecture 5.17): what is in force, the drafts and the rules. */
  readonly directives: DirectiveService;
  /** The quota of the profiles (architecture 5.6): signals, readings, state and freshness. */
  readonly quota: QuotaService;
  /**
   * The wakeups of exhausted profiles and the recheck (architecture 5.6; P9). The hooks of what
   * waits for a profile (P19, P15, the scheduler) are plugged in here with `setHook`.
   */
  readonly wakeups: WakeupManager;
  /** The consumption and the cost in money of the turns (architecture 5.6; Phase 5, P10). */
  readonly usage: UsageService;
  /**
   * The check of the consumption against \`ccusage\` (Phase 5, P12, N118): \`undefined\` when
   * \`usage.ccusage.enabled\` is off or its adapter could not be built; \`active\` says whether the
   * version check passed. The daemon works the same either way.
   */
  readonly usageAudit: UsageAudit | undefined;
  /**
   * The spending cap of the API profiles and Executors (architecture 5.6; Phase 5, P11). A spent
   * profile cap is `exhausted(budget)` in `quota`; `budget` answers for the Executors and decides
   * `on_exceeded` and `in_flight`.
   */
  readonly budget: BudgetService;
  /** The direct sessions (the Producer talking to an Actor outside any play): `undefined` when the execution is off. */
  readonly direct: DirectSessionService | undefined;
  /**
   * The accounts (architecture 5.6; Phase 5, P2 and P21): add, list, drain and remove. With the
   * execution on, a drain and a removal count and release the live sessions (the baton of P18).
   */
  readonly profiles: ProfileService;
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
 * 8. the reconciliation (5.21), while the MCP server and the REST commands hold their calls:
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
  let quota: QuotaService | undefined;
  let browserTools: BrowserTools | undefined;
  let telemetry: TelemetryRuntime | undefined;
  // The API server is started inside `run`; a failure after that point stops it from here.
  const apiRef: { server?: ApiServer } = {};
  // Closed until the reconciliation of the start-up ends: calls to the MCP server and to the
  // commands of the API wait here (5.21: "os comandos que mudam estado esperam").
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
    quota = new QuotaService({
      store: composition.store,
      clock: composition.clock,
      settings: quotaSettingsOf(config),
      logger: composition.logger,
      situations: composition.situations,
    });
    const usage = new UsageService({
      store: composition.store,
      clock: composition.clock,
      settings: usageSettingsOf(config),
      logger: composition.logger,
      situations: composition.situations,
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
              composition.situations,
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
    // Phase 8, P2: the OTLP receiver is up before any client starts, so each session is given its
    // address and token. A receiver that cannot listen is a notice, not a failed start.
    telemetry = await startTelemetry({
      config,
      store: composition.telemetry,
      vault: composition.vault,
      logger: composition.logger,
      situations: composition.situations,
      scenarioOf: async (playId) => (await composition?.store.plays.get(playId))?.scenarioId,
      clock: composition.clock,
    });
    mcp = await FrameworkMcpServer.start({
      registries,
      port: config.mcp.port,
      // N188: a getter, so `PUT /v1/config` changes it without a restart.
      get submitRetries() {
        return config.limits.submit_retries;
      },
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
      // macOS with `sandbox.mcp_bridge: unix` (N161): the confined client reaches the server here.
      ...(composition.sandbox?.mcpSocket === undefined
        ? {}
        : { socketPath: composition.sandbox.mcpSocket }),
    });
    return await run({
      options,
      config,
      composition,
      registries,
      mcp,
      telemetry,
      browserTools,
      directives,
      quota,
      usage,
      lock,
      version,
      prompts,
      orchestrationHandlers,
      scenarioHandlers,
      gate,
      apiRef,
    });
  } catch (error) {
    gate.open();
    await apiRef.server?.stop().catch(() => undefined);
    await directives?.stop().catch(() => undefined);
    await quota?.stop().catch(() => undefined);
    await mcp?.stop().catch(() => undefined);
    await telemetry?.stopExporter().catch(() => undefined);
    await telemetry?.stop().catch(() => undefined);
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
  readonly telemetry: TelemetryRuntime | undefined;
  readonly browserTools: BrowserTools | undefined;
  readonly directives: DirectiveService;
  readonly quota: QuotaService;
  readonly usage: UsageService;
  readonly lock: InstanceLock;
  readonly version: string;
  readonly prompts: PromptSource;
  readonly orchestrationHandlers: OrchestrationHandlers;
  readonly scenarioHandlers: ScenarioHandlers;
  readonly gate: RecoveryGate;
  /** Where `run` leaves the API server it started, so a failure of the start-up can stop it. */
  readonly apiRef: { server?: ApiServer };
}

async function run(input: RunInput): Promise<DaemonHandle> {
  const {
    options,
    config,
    composition,
    registries,
    mcp,
    telemetry,
    browserTools,
    directives,
    quota,
    usage,
    lock,
    version,
    prompts,
    gate,
    apiRef,
  } = input;
  const { clock, store, vault, logger } = composition;
  const paths = dataPaths(options.dataDir, options.overrides?.profileDir);
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
    await unlockVault(vault, options.passwordPrompt, logger, composition.situations);
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
  // P24 (N146): what compose and the vault noticed before this point is written now, after
  // `daemon.started`, and what comes later is written as it happens.
  composition.situations.open();
  // P4 (N214): the spans of the daemon are projected from the log from here on.
  composition.daemonSpans?.start();

  // P3 (Phase 6): the API listens from here, before the reconciliation. A read (`GET /v1/status`)
  // answers at once with the state `recovering`; a command waits on the gate (5.21).
  const daemonId = await loadOrCreateDaemonId(paths.daemonId, logger);
  const api = await ApiServer.start({
    port: config.api.port,
    token: await loadOrCreateApiToken(paths.apiToken, config.api.token),
    tokenMode: config.api.token,
    tokenFile: paths.apiToken,
    discoveryFile: paths.apiDiscovery,
    daemonId,
    corsOrigins: config.api.cors.origins,
    maxBodyBytes: config.api.max_body_bytes,
    rejectionWindowMs: config.api.rejection_events.every,
    now: () => clock.now(),
    logger,
    situations: composition.situations,
    gate,
    websocket: {
      maxPayloadBytes: config.api.chat.max_message_bytes,
      maxPendingPongs: config.api.chat.max_pending_pongs,
      closeGraceMs: config.api.chat.close_grace,
    },
  });
  apiRef.server = api;
  api.handlers.register('getStatus', () => ({ ...status(), daemonId, apiVersion: API_VERSION }));
  // P4 (Phase 6): the event stream. It reads the log through the hub and heartbeats on the clock.
  registerEventRoutes({
    handlers: api.handlers,
    onTokenRotated: (listener) => api.onTokenRotated(listener),
    daemonId,
    hub: composition.eventHub,
    lastId: () => store.events.lastId(),
    clock,
    config: config.api.sse,
    logger,
    situations: composition.situations,
  });

  await directives.start();

  const recoveryStartedAt = clock.now();
  // Before anything is resumed: the orphans, the sessions, the worktrees and the effects (5.21).
  const recovery = await reconcileBeforeResume({
    store,
    vcs: composition.vcs,
    codeHost: composition.codeHost,
    launcher: composition.launcher,
    logger,
    situations: composition.situations,
  });
  const quotaPrepare: (() => Promise<readonly ProfileRef[]>)[] = [];
  // The runner holds the baton port from the start; the orchestration binds the real one (P18, P16b).
  const handoff = createLateHandoff();
  // The rules of exhaustion (P19) come from the roles and the budget, which exist later: the runner
  // holds the port from the start and the daemon binds the real one once the budget is up.
  const exhaustion = createLateExhaustion();
  const execution = buildExecution(
    options,
    config,
    composition,
    paths.worktrees,
    mcp,
    quota,
    quotaPrepare,
    handoff.port,
    exhaustion.port,
    telemetry,
  );
  // The probes were handed over by `buildExecution`. The profiles the registry already has are
  // tracked before the readings start, so a MiniMax profile is read without waiting for a session.
  for (const prepare of quotaPrepare) {
    for (const ref of await prepare()) quota.track(ref);
  }
  // The catch-up and the readings start here.
  await quota.start();
  // P7 (Phase 8, N218): `GET /metrics`, when `telemetry.export` is `prometheus` or `both`. Otherwise the
  // route is a 404 and nothing is counted.
  const eventMetrics = exportsPrometheus(config.telemetry.export) ? new EventMetrics() : undefined;
  if (eventMetrics !== undefined) {
    eventMetrics.start(composition.eventHub, logger);
    const collector = new MetricsCollector({
      clock,
      store,
      pool: () => execution?.pool.stats(),
      events: eventMetrics,
      telemetry: composition.telemetry,
      exporter: () => telemetry?.exporter?.stats,
      cacheTtl: config.telemetry.prometheus.cache_ttl,
      logger,
    });
    api.setMetrics(() => collector.render());
  }
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
  // P3 (Phase 7, N44): the registry of the `/` commands. The chat socket below is registered before
  // the services it reads exist, so it asks for the registry at each command.
  const slashRef: { current: SlashCommandService | undefined } = { current: undefined };
  let shellCommands: ShellCommandService | undefined;
  let direct: DirectSessionService | undefined;
  if (execution !== undefined) {
    // The plays: the queue, the Director sessions, the effects and the Producer channel (P8).
    orchestration = startOrchestration({
      config,
      composition,
      execution,
      quota,
      mcp,
      registries,
      prompts,
      paths,
      handlers: input.orchestrationHandlers,
      scenarioHandlers: input.scenarioHandlers,
      handoff,
      home: homedir(),
    });
    // P6 (Phase 7): the `!` command of the Producer (N43). Its processes are written down like the
    // clients' (5.21); the sandbox is the one of layer 3, and `app.terminal` says whether it is used.
    shellCommands = new ShellCommandService({
      store,
      clock,
      launcher:
        composition.launcher === undefined
          ? undefined
          : new TrackingLauncher(
              composition.launcher,
              store,
              clock,
              logger,
              composition.situations,
            ),
      confine: composition.sandbox?.confineCommand,
      attachments: new AttachmentService({
        store,
        clock,
        scenariosDir: paths.scenarios,
        limits: () => ({
          maxSize: config.scenarios.attachment_max_size,
          readMax: config.scenarios.attachment_read_max,
        }),
      }),
      channel: orchestration.channel,
      ask: (scenarioId, question) => input.orchestrationHandlers.openApproval(scenarioId, question),
      env: () =>
        buildClientEnv(
          { env_inherit: config.tools.env_inherit, env_allow: config.tools.env_allow, env: {} },
          options.clientSearch?.env ?? process.env,
        ),
      scenariosDir: paths.scenarios,
      settings: () => ({
        shell: config.chat.shell_command,
        terminalMode: config.app.terminal,
        terminal: config.terminal,
      }),
      logger,
    });
    // P19 (Phase 7, N44/N190): the direct sessions with an Actor. They take a lease of the same pool
    // as any Actor, so the launcher, the sandbox and the quota of the profile apply.
    direct = new DirectSessionService({
      store,
      config,
      clock,
      logger,
      pool: execution.pool,
      selection: orchestration.selection,
      registries,
      vcs: composition.vcs,
      worktreeRoot: paths.worktrees,
      ideas: orchestration.ideas,
      opening: orchestration.opening,
    });
    // P27 (N206): the worktrees of direct sessions a dead daemon left behind, by
    // `direct_session.orphans`. It runs before any request can open a session.
    await direct.sweepOrphans();
    // P7 (Phase 6): the chat socket, over the Producer channel of the orchestration.
    registerChatRoutes({
      api,
      channel: orchestration.channel,
      shell: shellCommands,
      store,
      hub: composition.eventHub,
      situations: composition.situations,
      logger,
      now: () => clock.now(),
      ticketTtlMs: config.api.chat.ticket_ttl,
      heartbeatMs: config.api.chat.heartbeat,
      stateIntervalMs: config.api.chat.state_interval,
      resumeWindowMs: config.api.chat.resume_window,
      commands: () => slashRef.current,
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
  // there was nothing to settle. The record is the event, and the chat socket delivers it.
  await announceRecovery({
    store,
    logger,
    mode: config.recovery.notice,
    recovery,
    plays: resumed,
    attempts,
  });
  gate.open();
  // The ideas of a group the restart lost go back to the queue, and the queues that can move do.
  await orchestration?.ideas.settle();
  // P9: the wakeups of the exhausted profiles. What came due with the daemon stopped runs here, now
  // that everything that waits for a profile is up (5.21). The steps that own a hook (P19, P15, 9b)
  // plug it in with `wakeups.setHook` right here, before `start`, so a wakeup due at start-up finds it.
  // P11: the spending cap re-reads the spending on every turn the usage writes. It starts first, so
  // a cap that is spent (while the daemon was down, or by a lowered cap) is `exhausted(budget)`
  // before the wakeups look at the profiles.
  const budget = new BudgetService({
    store: composition.store,
    clock,
    settings: budgetSettingsOf(config),
    logger,
    quota,
    usage,
    situations: composition.situations,
  });
  await budget.start();
  if (orchestration !== undefined) {
    exhaustion.bind(
      createDaemonExhaustion({
        store: composition.store,
        selection: orchestration.selection,
        budget,
        logger,
      }),
    );
  }
  // P12 (N118): the check of the consumption against ccusage. It is an audit: it starts in the
  // background (the version check runs a process) and never holds the start-up or fails it.
  const usageAudit =
    composition.usageSource === undefined
      ? undefined
      : new UsageAudit({
          source: composition.usageSource,
          usage,
          store: composition.store,
          clock,
          logger,
          settings: usageAuditSettingsOf(config),
          situations: composition.situations,
        });
  const usageAuditStarted = usageAudit?.start();
  const wakeups = new WakeupManager({
    store: composition.store,
    clock,
    quota,
    settings: wakeupSettingsOf(config),
    logger,
    probes: (clientId) => quota.probeOf(clientId),
  });
  // P16: the demands that wait for an Executor look again when a profile comes back
  // (`quota.restored`), once the wakeup has settled it.
  wakeups.setHook('queued_demands', () => {
    orchestration?.selection.wake();
  });
  // P19: the attempts that wait for the reset (`AWAITING_RESUME`) resume the same conversation. The
  // hook may run more than once for a restoration; waking an attempt that is not waiting does nothing.
  wakeups.setHook('awaiting_resume', ({ profile, causes }) => {
    execution?.runner.restored(profile, causes);
  });
  await wakeups.start();

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
    telemetryBackup: composition.telemetryBackup,
    recordEvent: (event) => store.events.append(event),
    situations: composition.situations,
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
    composition.situations.record('daemon.notice', {
      kind: 'backup_unsupported',
      subject: null,
      detail: null,
    });
  }

  // The old Executor keys keep working (P13); the notice says where the new ones are.
  for (const warning of deprecationWarnings(config.orchestration)) {
    logger.warn(warning);
    composition.situations.record('daemon.notice', {
      kind: 'deprecated_config',
      subject: null,
      detail: situationText(warning),
    });
  }

  // P15b (N150): a strict cross-review that the lists of the Reviewer and the Critic cannot meet.
  try {
    for (const notice of await loadCrossCheckNotices(config, store)) {
      logger.warn({ role: notice.role }, notice.message);
      composition.situations.record('daemon.notice', {
        kind: 'cross_check_unsatisfiable',
        subject: situationSubject(notice.role),
        detail: situationText(notice.message),
      });
    }
  } catch (error) {
    // The check is a courtesy: a list the resolution refuses fails again at the first selection.
    logger.warn({ err: error }, 'the cross-review check of the role lists was not done');
  }

  state = 'running';
  logger.info({ version, dataDir: paths.dataDir }, 'daemon running');

  let stopping: Promise<void> | undefined;
  // P5 (Phase 8): the automatic ATIF export; it follows the log until the daemon stops.
  let atifAuto: AtifAutoExport | undefined;
  // P9 (Phase 8): the schedule of the daily aggregates; it runs until the daemon stops.
  let analysisService: AnalysisService | undefined;
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
      // First: no new request reaches a service that is about to stop (and `api.json` goes away).
      await attempt('api', () => api.stop());
      // The `!` commands end (their whole process tree) before the services they report to stop.
      await attempt('shell commands', async () => shellCommands?.close());
      // The direct sessions end (their worktrees are taken) before the pool they lease from stops.
      await attempt('direct sessions', async () => direct?.shutdown());
      // A login left open is cancelled: its process must not outlive the daemon.
      await attempt('logins', () => logins.stop());
      await attempt('scheduler', () => scheduler.stop());
      await attempt('orchestration', async () => orchestration?.quiesce());
      await attempt('directives', () => directives.stop());
      await attempt('wakeups', () => wakeups.stop());
      await attempt('budget', () => budget.stop());
      exhaustion.bind(undefined);
      await attempt('usage audit', async () => {
        await usageAuditStarted;
        await usageAudit?.stop();
      });
      await attempt('quota', () => quota.stop());
      await attempt('execution', async () => execution?.stop());
      await attempt('effects', async () => orchestration?.drain());
      // After the plays and the effects settle, so the end of a play still reaches the export.
      await attempt('atif export', async () => atifAuto?.stop());
      await attempt('analysis', async () => analysisService?.stop());
      await attempt('mcp', () => mcp.stop());
      // After the clients ended (`execution`): their last batches have arrived or never will.
      await attempt('telemetry', async () => telemetry?.stop());
      await attempt('browser', async () => browserTools?.close());
      // The spans of the last events are written before the telemetry store closes with the composition.
      await attempt('daemon spans', async () => composition.daemonSpans?.stop());
      // P7: the last pass of the OTLP export, with the spans just written, before the base closes.
      await attempt('telemetry export', async () => telemetry?.stopExporter());
      await attempt('metrics events', async () => eventMetrics?.stop());
      // The situations recorded so far are written before `daemon.stopped` closes the log.
      await attempt('situations', () => composition.situations.idle());
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

  // P21: the accounts, over the live sessions of the pool and the runner when there are any.
  const profiles = new ProfileService({
    store,
    vault,
    vaultBackend:
      composition.adapters.find((adapter) => adapter.port === 'SecretVault')?.id ??
      config.adapters.vault,
    clock,
    logger,
    situations: composition.situations,
    paths,
    settings: profileSettingsOf(config),
    adapters: (client) => {
      try {
        return execution?.pool.adapterOf(client);
      } catch {
        return undefined;
      }
    },
    transport: () => composition.transport,
    roleLists: roleListsOf(config, store),
    ...(execution === undefined
      ? {}
      : {
          sessions: liveProfileSessions({
            pool: execution.pool,
            runner: execution.runner,
            ...(orchestration === undefined ? {} : { directors: orchestration.directors }),
          }),
        }),
  });

  // P12 (Phase 6, N170): the layout records of the interfaces, read here and not later so a start
  // never waits for them; a record that cannot be used is replaced by the default and noticed.
  const layout = await LayoutPreferencesStore.open({
    dir: paths.layout,
    situations: composition.situations,
    logger,
  });

  // P3 (Phase 7, N44): the registry of the `/` commands, on the services above. The chat socket
  // and both groups of routes read it.
  const trajectory = new TrajectoryService({ store, config: () => config, vcs: composition.vcs });
  // P5 (Phase 8, N219): the ATIF export of a play. `atif.*` is read at each export, but the block
  // is cold: `PUT /v1/config` writes it and a restart applies it (the follower starts here).
  const atif = new AtifExporter({
    store,
    clock,
    vault,
    version,
    dataDir: paths.dataDir,
    settings: () => config.atif.export,
    pricing: () => usageSettingsOf(config).pricing,
    situations: composition.situations,
  });
  if (config.atif.export.on !== 'manual') {
    atifAuto = new AtifAutoExport({
      hub: composition.eventHub,
      exporter: atif,
      settings: () => config.atif.export,
      logger,
    });
    atifAuto.start();
  }
  // P9 (Phase 8, N55 and N217): the daily aggregates and the report over them. `analysis.*` is
  // cold, like `atif.*`: a restart applies it. Without the telemetry base there is nothing to
  // aggregate, and the route answers 503.
  if (composition.telemetry !== undefined) {
    analysisService = new AnalysisService({
      clock,
      telemetry: composition.telemetry,
      events: store.events,
      usage: store.usage,
      daemonSpans: composition.daemonSpans,
      settings: () => config.analysis,
      situations: composition.situations,
      logger,
    });
    analysisService.start();
  }
  const slash = new SlashCommandService({
    store,
    clock,
    logger,
    config,
    quota,
    usage,
    budget,
    profiles,
    directives,
    catalog: await SlashCatalog.load(),
    // N188: a getter, so `ui.locale` follows `PUT /v1/config`.
    get locale() {
      return resolveLocale(config.ui.locale, detectSystemLocale(process.env));
    },
    channel: orchestration?.channel,
    runner: orchestration?.runner,
    directors: orchestration?.directors,
    direct,
    pauseMode: () => config.pause.mode,
    trajectory,
  });
  slashRef.current = slash;
  // P4 (Phase 7, N121): the setup assistant. It cadastres Executors through the same service as
  // `ot executor add` (only its dry run: nothing enters `config.yaml` before the confirmation) and
  // reads the model catalogs of the clients the pool has; with no execution it sees no client.
  const clientAdapter = (client: string) => {
    try {
      return execution?.pool.adapterOf(client);
    } catch {
      return undefined;
    }
  };
  // P23 (Phase 7, N208 item 3, N202 (c)): one reload of a write of `config.yaml` into the running
  // configuration, shared by `PUT /v1/config`, the confirmation of the assistant and the cadastro
  // of an Executor. The spending caps are copied at the start, so they are read again when a hot
  // path touches `profiles` or `executors`.
  const configReloader = createConfigReloader({
    config,
    events: store.events,
    logger,
    onHot: async (hot) => {
      if (hot.some((path) => path.startsWith('profiles.') || path.startsWith('executors.'))) {
        await budget.applySettings(budgetSettingsOf(config));
      }
    },
  });
  const setup = new SetupService({
    store,
    clock,
    logger,
    configPath: paths.config,
    profiles,
    reload: configReloader.reload,
    executors: new ExecutorService({
      store,
      clock,
      logger,
      configPath: paths.config,
      catalogs: (client) => clientAdapter(client)?.models,
      reload: configReloader.reload,
    }),
    catalogs: (client) => clientAdapter(client)?.models,
    installedClients: () =>
      new Set(CLIENT_IDS.filter((client) => clientAdapter(client) !== undefined)),
  });

  // P5 (Phase 6): the read routes of the REST API. They need the services above, so they are
  // registered here and not where `getStatus` is; a read before this point answers 404.
  registerReadRoutes(api.handlers, {
    store,
    slash,
    direct,
    trajectory,
    atif,
    analysis: analysisService,
    attempts: execution?.runner,
    config,
    quota,
    usage,
    budget,
    profiles,
    layout,
    setup,
    attachments: new AttachmentService({
      store,
      clock,
      scenariosDir: paths.scenarios,
      limits: () => ({
        maxSize: config.scenarios.attachment_max_size,
        readMax: config.scenarios.attachment_read_max,
      }),
    }),
  });

  // P5 (Phase 7, N186): the official login of the accounts, opened from an interface.
  const logins = new ProfileLoginService({
    store,
    clock,
    logger,
    adapters: (client) => {
      try {
        return execution?.pool.adapterOf(client);
      } catch {
        return undefined;
      }
    },
  });

  // P6 (Phase 6): the commands of the REST API, on the same services. They wait for `gate` (the
  // reconciliation of the start-up) before they run, which the server does for every command.
  registerCommandRoutes(api.handlers, {
    store,
    clock,
    logger,
    directives,
    profiles,
    logins,
    configPath: paths.config,
    config,
    reloader: configReloader,
    idempotencyTtlMs: () => config.api.idempotency_ttl,
    layout,
    channel: orchestration?.channel,
    runner: orchestration?.runner,
    attempts: execution?.runner,
    pauseMode: () => config.pause.mode,
    ideas: orchestration?.ideas,
    slash,
    setup,
    direct,
  });

  const handle: DaemonHandle = {
    clock,
    // The store as the adapter built it; the daemon's own code appends through the validated one.
    store: composition.rawStore,
    eventHub: composition.eventHub,
    api,
    daemonId,
    vault,
    registries,
    adapters: composition.adapters,
    execution,
    mcpUrl: mcp.url,
    telemetryUrl: telemetry?.receiver.url,
    producer: orchestration?.channel,
    profiles,
    directives,
    quota,
    wakeups,
    usage,
    usageAudit,
    budget,
    direct,
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
  quota: QuotaService,
  quotaPrepare: (() => Promise<readonly ProfileRef[]>)[],
  handoff: HandoffPort,
  exhaustion: ExhaustionPort,
  telemetry: TelemetryRuntime | undefined,
): Execution | undefined {
  const { logger } = composition;
  const { launcher: rawLauncher } = composition;
  if (rawLauncher === undefined) {
    logger.warn('this platform has no process launcher yet; the execution of attempts is off');
    composition.situations.record('daemon.notice', {
      kind: 'execution_off',
      subject: 'no_launcher',
      detail: null,
    });
    return undefined;
  }
  // Every process the clients start is written down, so the next daemon can find the orphans (5.21).
  const launcher = new TrackingLauncher(
    rawLauncher,
    composition.store,
    composition.clock,
    logger,
    composition.situations,
  );
  const factory = options.clients ?? productionClients(config, options.clientSearch);
  const built = factory({
    launcher,
    clock: composition.clock,
    transport: composition.transport,
    paths: dataPaths(options.dataDir, options.overrides?.profileDir),
    logger,
    situations: composition.situations,
    // The API key of a profile reaches only the process of that profile (Phase 5, P2).
    secretEnv: profileSecretEnv({
      store: composition.store,
      vault: composition.vault,
      apiKeyEnv: config.profiles.api_key_env,
      logger,
      situations: composition.situations,
    }),
    ...(composition.sandbox === undefined
      ? {}
      : {
          sandbox: {
            capabilities: composition.sandbox.capabilities,
            // The framework MCP server is the daemon's own loopback service the client must reach.
            launchWrapper: composition.sandbox.launchWrapper(() => [
              mcp.url,
              // The clients export their telemetry to the receiver, also from inside the sandbox.
              ...(telemetry === undefined ? [] : [telemetry.receiver.url]),
            ]),
          },
        }),
  });
  if (built.length === 0) {
    logger.warn(
      'no client is enabled (none configured or found in PATH); the execution of attempts is off',
    );
    composition.situations.record('daemon.notice', {
      kind: 'execution_off',
      subject: 'no_client',
      detail: null,
    });
    return undefined;
  }
  // The service listens to the sessions of every client (the limit error with its reset time, the
  // usage events), and each client has its quota probe (P6 to P8); the service takes it from here.
  const clients = built.map((client) => tapClient(client, quota, logger, composition.situations));
  // P25: an OpenCode profile linked to a Codex one is read through the probe of Codex.
  const codexQuota = clients.find((client) => client.id === 'codex')?.quota;
  for (const client of clients) {
    const wiring = quotaProbeOf(client, {
      config,
      codexQuota,
      store: composition.store,
      vault: composition.vault,
      clock: composition.clock,
      logger,
      situations: composition.situations,
    });
    quota.addProbe(client.id, wiring.probe);
    if (wiring.prepare !== undefined) quotaPrepare.push(wiring.prepare);
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
    quota,
    memory: composition.memory,
    handoff,
    exhaustion,
    ...(telemetry === undefined ? {} : { telemetry: telemetry.clients }),
    ...(composition.daemonSpans === undefined
      ? {}
      : { onWait: composition.daemonSpans.recordWait }),
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
export async function unlockVault(
  vault: LockableSecretVault,
  prompt: PasswordPrompt | undefined,
  logger: Logger,
  situations?: SituationSink,
): Promise<void> {
  if (!vault.isLocked) return;
  if (prompt === undefined) {
    logger.warn('the vault is locked and no password prompt is available; it stays locked');
    situations?.record('daemon.notice', {
      kind: 'vault_locked',
      subject: 'no_prompt',
      detail: null,
    });
    return;
  }
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
    const password = await prompt({ attempt, maxAttempts: MAX_PASSWORD_ATTEMPTS });
    if (password === undefined) {
      logger.warn('no master password given; the vault stays locked');
      situations?.record('daemon.notice', {
        kind: 'vault_locked',
        subject: 'no_password',
        detail: null,
      });
      return;
    }
    try {
      await vault.unlock(password);
      logger.info('vault unlocked');
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'PERMISSION_DENIED')) throw error;
      logger.warn({ attempt }, 'wrong master password');
      situations?.record('daemon.notice', {
        kind: 'vault_wrong_password',
        subject: null,
        detail: `attempt ${String(attempt)} of ${String(MAX_PASSWORD_ATTEMPTS)}`,
      });
    }
  }
  throw new PermissionDenied(
    `Wrong master password ${String(MAX_PASSWORD_ATTEMPTS)} times; the daemon was not started`,
  );
}
