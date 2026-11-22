// SPDX-License-Identifier: MPL-2.0
import type { OwnSchemas } from './updates/apply/coordinator.js';
import { newestMigration } from './updates/apply/schemas.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { PlaywrightBrowserSession } from '@otheater/adapter-browser-playwright';
import {
  CLAUDE_CODE_ACP_PACKAGES,
  CLAUDE_CODE_ADAPTER_VERSION,
  ClaudeCodeAdapter,
  DEFAULT_COMMAND as CLAUDE_DEFAULT_COMMAND,
  type ConfigOptionsReader,
} from '@otheater/adapter-client-claude-code';
import {
  CODEX_ACP_PACKAGES,
  CodexAdapter,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_QUOTA_COMMAND,
  type CodexConfigSource,
} from '@otheater/adapter-client-codex';
import {
  OPENCODE_PACKAGES,
  OpenCodeAdapter,
  opencodeAdapterVersion,
} from '@otheater/adapter-client-opencode';
import { SystemClock, systemClockAdapter } from '@otheater/adapter-clock-system';
import {
  POSIX_MEMORY_PROBE_ADAPTER,
  POSIX_PROCESS_LAUNCHER_ADAPTER,
  PosixMemoryProbe,
  PosixProcessLauncher,
} from '@otheater/adapter-platform-posix';
import {
  checkoutRoots,
  locateJobLauncher,
  WINDOWS_PROCESS_LAUNCHER_ADAPTER,
  WindowsProcessLauncher,
} from '@otheater/adapter-platform-windows';
import { SRT_SANDBOX_ADAPTER, SrtSandbox } from '@otheater/adapter-sandbox-srt';
import { AcpTransport } from '@otheater/adapter-session-acp';
import {
  backupDatabase,
  MIGRATIONS as STORE_MIGRATIONS,
  parseBackupMethod,
  restoreDatabase,
  SQLITE_STORE_ADAPTER,
  SqliteStore,
  SqliteStoreConfigSchema,
  type SqliteStoreConfig,
} from '@otheater/adapter-store-sqlite';
import {
  backupTelemetryFile,
  MIGRATIONS as TELEMETRY_MIGRATIONS,
  SQLITE_TELEMETRY_ADAPTER,
  SqliteTelemetryStore,
  type SqliteTelemetryConfigInput,
  type TelemetryResetInfo,
} from '@otheater/adapter-telemetry-sqlite';
import { CcusageSource } from '@otheater/adapter-usage-ccusage';
import {
  EncryptedFileVault,
  EncryptedFileVaultConfigSchema,
  encryptedFileVaultAdapter,
} from '@otheater/adapter-vault-file';
import {
  KeyringVault,
  KeyringVaultConfigSchema,
  keyringVaultAdapter,
} from '@otheater/adapter-vault-keyring';
import { GIT_VCS_ADAPTER, GitVcs } from '@otheater/adapter-vcs-git';
import {
  AdapterUnavailable,
  BROWSER_SESSION_PORT_VERSION,
  CLOCK_PORT_VERSION,
  MEMORY_PROBE_PORT_VERSION,
  InvalidInput,
  isLockableSecretVault,
  PROCESS_LAUNCHER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  SANDBOX_PORT_VERSION,
  SECRET_VAULT_PORT_VERSION,
  STORE_PORT_VERSION,
  TELEMETRY_STORE_PORT_VERSION,
  USAGE_SOURCE_PORT_VERSION,
  VCS_PORT_VERSION,
  type Adapter,
  type BrowserSession,
  type ClientAdapter,
  type ClientAdapterOptions,
  type ClientAdapterWarning,
  type Clock,
  type CodeHost,
  type MinLayers,
  type MemoryProbe,
  type ProcessLauncher,
  type Sandbox,
  type SandboxAvailability,
  type SecretVault,
  type SessionTransport,
  type Store,
  type UsageSource,
  type StoreBackupOptions,
  type StoreBackupResult,
  type TelemetryStore,
  type Vcs,
} from '@otheater/core';
import semver from 'semver';
import { z } from 'zod';
import {
  adapterVersionOf,
  buildClientEnv,
  pathFinder,
  selectClients,
  type ManagedProbeFn,
  type ClientFactory,
  type ClientFactoryParts,
  type FindExecutable,
} from './clients.js';
import {
  AdapterManager,
  isManagedClient,
  type AdapterManagerOptions,
  type ManagedClientId,
} from './adapters/manager.js';
import { resolveClientVersioning, type ClientVersioning } from './client-version.js';
import { sessionConfigReader } from './catalog-reader.js';
import { clientWarningLog, type ClientWarningLog } from './client-warnings.js';
import { SituationLog, situationSubject, situationText, type SituationSink } from './situations.js';
import {
  describeZodError,
  resolveMcpBridge,
  sessionsPerProcessOf,
  type ClientId,
  type DaemonConfig,
  type ProcessesConfig,
} from './config.js';
import { validateEventsOf, type EventValidation } from './event-validation.js';
import { createEventHub, type EventHub } from './events/event-hub.js';
import { DaemonSpans } from './telemetry/daemon-spans.js';
import { WaitEvents } from './telemetry/wait-events.js';
import { chatFeedStore } from './orchestration/chat-feed.js';
import { recordFeedStore } from './orchestration/record-feed.js';
import { createLogger, type DaemonLogger, type Logger } from './logger.js';
import { dataPaths, profileDirOf, type DataPaths, type Env, type ProfileNames } from './paths.js';
import { buildSandboxWiring, type SandboxWiring } from './sandbox-wiring.js';

/** The ports the daemon composes. */
export type PortName =
  | 'Store'
  | 'SecretVault'
  | 'Clock'
  | 'Vcs'
  | 'ProcessLauncher'
  | 'Sandbox'
  | 'BrowserSession'
  | 'MemoryProbe'
  | 'UsageSource'
  | 'TelemetryStore';

/** What `daemon.started` and the status report about one adapter. */
export interface AdapterRecord {
  readonly port: PortName;
  /** Id as written in the config; `override` when a test handed in its own instance. */
  readonly id: string;
  /** The range the adapter declares (`^0.1.0`). */
  readonly range: string;
  /** The version of the port contract this daemon runs with. */
  readonly portVersion: string;
}

/** Instances that replace the configured adapters, so tests run the same daemon over fakes. */
export interface ComposeOverrides {
  readonly clock?: Clock;
  readonly store?: Store;
  /**
   * The telemetry base (P1 of Phase 8). `SqliteTelemetryStore` over `<data>/<telemetry.file>` by
   * default; `'none'` runs the daemon without one, whatever `telemetry.enabled` says.
   */
  readonly telemetry?: TelemetryStore | 'none';
  readonly vault?: SecretVault;
  /** Version control for the worktrees of the attempts (`GitVcs` by default). */
  readonly vcs?: Vcs;
  /**
   * Starts the adapter processes (the process group on Linux and macOS; on Windows the Job Object
   * launcher chosen by `processes.windows_launcher`, see {@link chooseLauncher}).
   */
  readonly launcher?: ProcessLauncher;
  /** The system {@link chooseLauncher} reads, when `launcher` is not given (the tests). */
  readonly launcherDeps?: LauncherChoiceDeps;
  /** Reads the free RAM for `pool.admission.mode: ram` (`PosixMemoryProbe` by default). */
  readonly memory?: MemoryProbe;
  /**
   * The browser of the agent (P6, 5.19). By default the Playwright adapter over a Chromium that
   * is a child of the launcher; tests hand in `FakeBrowserSession`.
   */
  readonly browser?: BrowserSession;
  /** The wire the sessions speak (`AcpTransport` by default). */
  readonly transport?: SessionTransport;
  /**
   * Layer 3 (`SrtSandbox` by default, when `sandbox.mode` is `runtime` and the platform has one).
   * `'none'` runs the daemon without it, whatever `sandbox.mode` says.
   */
  readonly sandbox?: Sandbox | 'none';
  /**
   * Test seam: where a profile lives for the sessions and the clients, instead of
   * `<data>/profiles/<client>/<profile>` (see `DataPaths.profileDirOverride`). The registry of the
   * profiles (create, remove) ignores it. The product never sets it.
   */
  readonly profileDir?: (ref: ProfileNames) => string;
  /**
   * The source of the `ccusage` check (P12, N118). Used only when `usage.ccusage.enabled`; by
   * default the `CcusageSource` adapter over the binary the config names. Tests hand in a fake.
   */
  readonly usageSource?: UsageSource;
  /**
   * The code host the plays deliver to (P8). [proposta] There is no default: the GitHub adapter
   * is not a dependency of the daemon package yet, so without this instance a play runs up to
   * the delivery and the delivery fails with a clear error.
   */
  readonly codeHost?: CodeHost;
}

export interface ComposeOptions {
  readonly dataDir: string;
  readonly overrides?: ComposeOverrides;
  /** Use this logger instead of building one from `config.log` (it is not closed by `close()`). */
  readonly logger?: Logger;
  /**
   * The event registry and what to do with an event it does not accept (`events.unknown_type`).
   * When set, the `store` of the composition validates every `append`; when absent it does not.
   */
  readonly events?: Pick<EventValidation, 'registry' | 'unknownType'>;
}

export interface Composition {
  readonly clock: Clock;
  /** What the daemon's own code uses: every `append` is checked against the event registry. */
  readonly store: Store;
  /**
   * [proposta] The store as the adapter built it, with no event validation. `DaemonHandle.store`
   * exposes this one (the Phase 2 tests append their own event types through it); the same
   * instance as `store` when `events` is not set. Both go through the {@link EventHub}.
   */
  readonly rawStore: Store;
  /**
   * P2 (Phase 6): the notice of a new event, in process. Every `append` of the daemon (through
   * `store` and through `rawStore`) is announced after it is committed; `hub.follow` is what the
   * API streams read from.
   */
  readonly eventHub: EventHub;
  readonly vault: SecretVault;
  readonly logger: Logger;
  readonly adapters: readonly AdapterRecord[];
  /** Version control for the execution of attempts. */
  readonly vcs: Vcs;
  /**
   * [proposta] `undefined` where the daemon has no launcher yet (Windows, until the launcher with
   * the Job Object is wired): the execution of attempts is off there.
   */
  readonly launcher: ProcessLauncher | undefined;
  /** Reads the free RAM; the session pool asks it only when `pool.admission.mode` is not `slots`. */
  readonly memory: MemoryProbe;
  readonly transport: SessionTransport;
  /**
   * Layer 3, ready to use: `undefined` when `sandbox.mode` is `off`, the platform has no adapter
   * (Windows, N94) or the mechanism does not work here (the reason is in the log). Then
   * `security.unenforced` decides about `writeScope` and `network`.
   */
  readonly sandbox: SandboxWiring | undefined;
  /**
   * [proposta] The browser of the agent, or `undefined` where there is no launcher (Windows,
   * until the launcher with the Job Object is wired): the `browser_*` tools are not served there.
   */
  readonly browser: BrowserSession | undefined;
  /** The code host of the deliveries, or `undefined` when none was handed in (see the override). */
  readonly codeHost: CodeHost | undefined;
  /**
   * The `ccusage` source (P12, N118): set only when `usage.ccusage.enabled` and the adapter could
   * be built. Whether it works (the version) is checked when the daemon starts the audit.
   */
  readonly usageSource: UsageSource | undefined;
  /**
   * P24 (N146): the sink of the situations that are also events (over the validated `store`).
   * Closed until the daemon calls `open()` after `daemon.started`; wait for `idle()` before closing.
   */
  readonly situations: SituationLog;
  /**
   * The telemetry base (P1 of Phase 8, N54), or `undefined` when `telemetry.enabled` is `off`.
   * Never what the orchestration depends on: a failure here is a counted loss, not an error.
   */
  readonly telemetry: TelemetryStore | undefined;
  /**
   * Consistent copy of the telemetry file into `dest` for `backup.telemetry: include`; resolves
   * `false` when there is nothing to copy. `undefined` when the base is off or is an override.
   */
  readonly telemetryBackup: ((dest: string) => Promise<boolean>) | undefined;
  /**
   * The spans of the daemon (P4 of Phase 8): the projector of the event log, or `undefined` when
   * there is no telemetry base or `telemetry.daemon_spans` is `off`. The daemon starts it after
   * `daemon.started` and stops it before the situations are closed.
   */
  readonly daemonSpans: DaemonSpans | undefined;
  /**
   * The events of the waits of the daemon (P15 of Phase 8, N222 (a)): `undefined` when
   * `events.wait_threshold` is `off`. The daemon closes it (its timers) before the situations are.
   */
  readonly waitEvents: WaitEvents | undefined;
  /** Closes the store, locks the vault and flushes the log. Idempotent. */
  close(): Promise<void>;
}

/**
 * Checks that an adapter implements `port` and that its `implements.range` covers `portVersion`
 * (architecture 5.18, "Versão dos contratos"). Pure.
 *
 * - A range that is not valid semver, or an adapter for another port: `InvalidInput` (the
 *   adapter's declaration is wrong).
 * - A valid range that does not include the port version: `AdapterUnavailable` [proposta]: the
 *   adapter is well formed but cannot be used with this daemon, and the message names the port,
 *   the version the daemon runs with and the range received.
 */
export function checkAdapterRange(
  adapter: Adapter,
  port: PortName,
  portVersion: string,
): AdapterRecord {
  const { range } = adapter.implements;
  if (adapter.implements.port !== port) {
    throw new InvalidInput(
      `Adapter "${adapter.id}" implements port ${adapter.implements.port}, not ${port}`,
    );
  }
  if (semver.validRange(range) === null) {
    throw new InvalidInput(
      `Adapter "${adapter.id}" declares an invalid range for port ${port}: "${range}"`,
    );
  }
  if (!semver.satisfies(portVersion, range)) {
    throw new AdapterUnavailable(
      `Adapter "${adapter.id}" does not support port ${port} version ${portVersion}: ` +
        `it declares the range "${range}"`,
    );
  }
  return { port, id: adapter.id, range, portVersion };
}

/** Validates one adapter section of the config; errors name the full key (`store.driver`). */
function parseSection<S extends z.ZodType>(
  section: string,
  schema: S,
  value: Record<string, unknown>,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const message = describeZodError(parsed.error)
      .split('; ')
      .map((part) => `${section}.${part}`)
      .join('; ');
    throw new InvalidInput(`config.yaml: ${message}`, { cause: parsed.error });
  }
  return parsed.data;
}

/** [proposta] `<data>/vault.enc`, used by `adapters.vault: encrypted-file` when `vault.path` is not set. */
export const DEFAULT_VAULT_FILE = 'vault.enc';

const SqliteSectionSchema = SqliteStoreConfigSchema.omit({ path: true });

function storeSection(config: DaemonConfig, paths: DataPaths): SqliteStoreConfig {
  const section = parseSection('store', SqliteSectionSchema, config.store);
  return { ...section, path: paths.store };
}

/** Where the telemetry base lives: `telemetry.file`, relative to the data folder or absolute. */
export function telemetryPath(config: DaemonConfig, dataDir: string): string {
  const file = config.telemetry.file;
  return isAbsolute(file) ? file : join(dataDir, file);
}

/** The adapter's config from the `telemetry.*` keys; the driver and the lock wait come from `store.*`. */
function telemetrySection(
  config: DaemonConfig,
  dataDir: string,
  paths: DataPaths,
): SqliteTelemetryConfigInput {
  const store = storeSection(config, paths);
  const { write, synchronous } = config.telemetry;
  return {
    path: telemetryPath(config, dataDir),
    driver: store.driver,
    busyTimeoutMs: store.busyTimeoutMs,
    synchronous,
    writeBatch: write.batch,
    queueMax: write.queue_max,
    flushIntervalMs: write.flush_interval,
    retryAfterMs: write.retry_after,
  };
}

/**
 * What the daemon does when the adapter recreates the base or gives up: a warning with the full
 * path in the log, and the event `telemetry.store_reset` (basename only, no content).
 */
function telemetryResetHandler(
  logger: Logger,
  situations: SituationSink,
): (info: TelemetryResetInfo) => void {
  return (info) => {
    logger.warn(
      { reason: info.reason, outcome: info.outcome, brokenFile: info.brokenFile },
      `the telemetry base was ${info.outcome === 'recreated' ? 'recreated' : 'left unavailable'}: ${info.error}`,
    );
    situations.record('telemetry.store_reset', {
      reason: info.reason,
      outcome: info.outcome,
      brokenFile: info.brokenFile === null ? null : basename(info.brokenFile),
      resets: info.resets,
    });
  };
}

/**
 * The copy of the telemetry file for `ot backup` while a daemon runs (the base is not ours to open):
 * a consistent snapshot read from the file. Resolves `false` when there is no file.
 */
export function composeTelemetryBackup(
  config: DaemonConfig,
  dataDir: string,
): (dest: string) => Promise<boolean> {
  const paths = dataPaths(dataDir);
  const path = telemetryPath(config, dataDir);
  const { driver } = storeSection(config, paths);
  return (destPath) => backupTelemetryFile({ path, destPath, driver });
}

/** The `Vcs` of the daemon: git, after the range check like every adapter. */
export function defaultVcs(): Vcs {
  checkAdapterRange(GIT_VCS_ADAPTER, 'Vcs', VCS_PORT_VERSION);
  return new GitVcs();
}

/** The memory probe of this platform: `/proc/meminfo` on Linux, `os.freemem()` elsewhere [N]. */
export function defaultMemoryProbe(): MemoryProbe {
  checkAdapterRange(POSIX_MEMORY_PROBE_ADAPTER, 'MemoryProbe', MEMORY_PROBE_PORT_VERSION);
  return new PosixMemoryProbe();
}

/** What {@link chooseLauncher} may be given in place of the real system (the tests). */
export interface LauncherChoiceDeps {
  readonly platform?: NodeJS.Platform;
  /** The executable of the running program, where the Windows launcher is looked for first. */
  readonly execPath?: string;
  /** Folders that hold a checkout's `native/` (default: the one this module runs from, if any). */
  readonly checkoutRoots?: readonly string[];
  /** True when a file exists (the search of the Windows launcher). */
  readonly exists?: (path: string) => boolean;
  /** Builds the Windows launcher from the path found and `processes.windows_shims`. */
  readonly createWindows?: (launcherPath: string, shims: 'resolve' | 'refuse') => ProcessLauncher;
}

/** The launcher of this platform and, when it fell back to none, why (told as a notice by `compose`). */
export interface LauncherChoice {
  readonly launcher: ProcessLauncher | undefined;
  /** Set only when `processes.windows_launcher: auto` found no `ot-job-launcher.exe`. */
  readonly fallback?: string;
}

/**
 * Picks the process launcher (architecture 5.9). Linux and macOS: the process group, always.
 * Windows (Phase 10, P2; `processes.windows_launcher`): `auto` uses the Job Object launcher when
 * the file is found and otherwise falls to none, saying why in `fallback`; `job_object` throws
 * `AdapterUnavailable` without the file (the daemon does not start); `off` is none.
 */
export function chooseLauncher(
  settings: ProcessesConfig,
  deps: LauncherChoiceDeps = {},
): LauncherChoice {
  if ((deps.platform ?? process.platform) !== 'win32') {
    checkAdapterRange(
      POSIX_PROCESS_LAUNCHER_ADAPTER,
      'ProcessLauncher',
      PROCESS_LAUNCHER_PORT_VERSION,
    );
    return { launcher: new PosixProcessLauncher() };
  }
  if (settings.windows_launcher === 'off') return { launcher: undefined };
  const found = locateJobLauncher({
    configuredPath: settings.windows_launcher_path ?? null,
    execPath: deps.execPath ?? process.execPath,
    checkoutRoots: deps.checkoutRoots ?? checkoutRoots(),
    ...(deps.exists === undefined ? {} : { exists: deps.exists }),
  });
  if (!found.found) {
    const searched = found.searched.join(', ');
    if (settings.windows_launcher === 'job_object') {
      throw new AdapterUnavailable(
        `processes.windows_launcher is job_object and ot-job-launcher.exe was not found (looked at: ${searched})`,
      );
    }
    return {
      launcher: undefined,
      fallback: `processes.windows_launcher is auto and ot-job-launcher.exe was not found (looked at: ${searched}); the execution of attempts and the browser tools stay off`,
    };
  }
  const launcher =
    deps.createWindows?.(found.path, settings.windows_shims) ??
    new WindowsProcessLauncher({ launcherPath: found.path, shims: settings.windows_shims });
  checkAdapterRange(
    WINDOWS_PROCESS_LAUNCHER_ADAPTER,
    'ProcessLauncher',
    PROCESS_LAUNCHER_PORT_VERSION,
  );
  return { launcher };
}

/** The process launcher of this platform, or `undefined` where there is none (see {@link chooseLauncher}). */
export function defaultLauncher(
  settings: ProcessesConfig = { windows_launcher: 'auto', windows_shims: 'resolve' },
  deps: LauncherChoiceDeps = {},
): ProcessLauncher | undefined {
  return chooseLauncher(settings, deps).launcher;
}

/**
 * The browser of the agent: the Playwright adapter, which runs Chromium as a child of `launcher`
 * (5.9). Nothing starts here: the first `open` of a scenario does it, after the RAM admission.
 * `undefined` without a launcher.
 */
export function defaultBrowser(
  config: DaemonConfig,
  profilesDir: string,
  launcher: ProcessLauncher | undefined,
  logger: Logger,
  situations?: SituationSink,
): BrowserSession | undefined {
  if (launcher === undefined) return undefined;
  const settings = config.browser;
  const session = new PlaywrightBrowserSession({
    launcher,
    profilesDir: resolve(profilesDir, 'browser'),
    executablePath: settings.executable_path,
    sandbox: settings.sandbox,
    minFreeMemoryBytes: settings.min_free_memory_mb * 1024 * 1024,
    maxInstances: settings.max_instances,
    timeoutMs: settings.timeout_ms,
    onWarning: (message) => {
      logger.warn({ adapter: session.id }, message);
      situations?.record('daemon.notice', {
        kind: 'browser_warning',
        subject: situationSubject(session.id),
        detail: situationText(message),
      });
    },
  });
  checkAdapterRange(session, 'BrowserSession', BROWSER_SESSION_PORT_VERSION);
  return session;
}

/**
 * One probe per process and configuration: the check runs a real confined command, which costs a
 * moment, and the answer does not change while the daemon runs. The probe uses an adapter of its
 * own and closes it, so nothing stays open until the daemon really needs the sandbox.
 */
const sandboxProbes = new Map<string, Promise<SandboxAvailability>>();

export function probeSandbox(): Promise<SandboxAvailability> {
  const key = process.platform;
  let probe = sandboxProbes.get(key);
  if (probe === undefined) {
    probe = (async () => {
      const own = new SrtSandbox();
      try {
        return await own.available();
      } finally {
        await own.close();
      }
    })();
    sandboxProbes.set(key, probe);
  }
  return probe;
}

/** Layer 3 of this daemon (architecture 5.8): checked, logged, and `undefined` where it is not there. */
async function composeSandbox(
  config: DaemonConfig,
  paths: DataPaths,
  overrides: ComposeOverrides,
  logger: Logger,
  situations?: SituationSink,
): Promise<SandboxWiring | undefined> {
  if (overrides.sandbox === 'none' || config.sandbox.mode === 'off') {
    logger.info(
      { mode: config.sandbox.mode },
      'sandbox is off: writeScope and network have no layer, security.unenforced decides',
    );
    return undefined;
  }
  // N161: with the unix bridge the folder of the MCP socket exists before the sandbox, which takes
  // it as the one folder whose sockets a client may connect to. Its own short folder in the temp
  // of the system (macOS limits the path of a socket to 104 bytes), mode 0700 by `mkdtemp`, and
  // the real path (on macOS `/var` is `/private/var`, and Seatbelt reads the real one).
  const unix = resolveMcpBridge(config.sandbox.mcp_bridge, process.platform) === 'unix';
  const socketDir = unix ? realpathSync(mkdtempSync(join(tmpdir(), 'ot-mcp-'))) : undefined;
  const dropSocketDir = (): void => {
    if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
  };
  let sandbox: Sandbox;
  if (overrides.sandbox !== undefined) {
    sandbox = overrides.sandbox;
    const availability = await sandbox.available();
    if (!availability.ok) {
      dropSocketDir();
      logger.warn({ reason: availability.reason }, 'sandbox is not available');
      situations?.record('daemon.notice', {
        kind: 'sandbox_unavailable',
        subject: situationSubject(sandbox.id),
        detail: situationText(availability.reason),
      });
      return undefined;
    }
  } else {
    checkAdapterRange(SRT_SANDBOX_ADAPTER, 'Sandbox', SANDBOX_PORT_VERSION);
    const availability = await probeSandbox();
    if (!availability.ok) {
      dropSocketDir();
      logger.warn(
        { reason: availability.reason, platform: process.platform },
        'layer 3 (sandbox) is missing here: writeScope and network have no guarantee, security.unenforced decides',
      );
      situations?.record('daemon.notice', {
        kind: 'sandbox_unavailable',
        subject: situationSubject(process.platform),
        detail: situationText(availability.reason),
      });
      return undefined;
    }
    sandbox = new SrtSandbox(socketDir === undefined ? {} : { unixSocketDirs: [socketDir] });
  }
  logger.info({ sandbox: sandbox.id, fields: sandbox.capabilities().fields }, 'sandbox');
  return buildSandboxWiring({
    sandbox,
    config,
    home: homedir(),
    dataDir: paths.dataDir,
    ...(socketDir === undefined ? {} : { mcpSocketDir: socketDir }),
    onNestedUserNamespaces: ({ client, worktree }) => {
      logger.warn(
        { client, worktree },
        'clients.codex.inner_sandbox is nested: the sandbox lets this client process make user namespaces, so its write denies (denyWrite and the mandatory denies) are weaker against a hostile command (documented by the library)',
      );
      situations?.record('daemon.notice', {
        kind: 'sandbox_nested',
        subject: situationSubject(client),
        detail: situationText(worktree),
      });
    },
  });
}

/**
 * The `ccusage` source, when `usage.ccusage.enabled` (P12, N118): the adapter over the executable
 * the config names, run with a home folder of the daemon's own (`<data>/scratch/ccusage-home`) so it
 * never sees the owner's. A source that cannot be built is a warning and an event, not a failure of
 * the start-up: the daemon works with the signals alone.
 */
function composeUsageSource(
  config: DaemonConfig,
  paths: DataPaths,
  overrides: ComposeOverrides,
  adapters: AdapterRecord[],
  logger: Logger,
  situations: SituationSink,
): UsageSource | undefined {
  const settings = config.usage.ccusage;
  if (!settings.enabled) return undefined;
  try {
    let source: UsageSource;
    if (overrides.usageSource !== undefined) {
      source = overrides.usageSource;
      adapters.push(overrideRecord('UsageSource', USAGE_SOURCE_PORT_VERSION));
    } else {
      source = new CcusageSource({
        command: settings.command ?? 'ccusage',
        commandMode: settings.command_mode,
        homeDir: resolve(paths.scratch, 'ccusage-home'),
        requiredVersion: settings.version,
        timeoutMs: settings.timeout,
        pricing: settings.pricing,
      });
      adapters.push(checkAdapterRange(source, 'UsageSource', USAGE_SOURCE_PORT_VERSION));
    }
    return source;
  } catch (error) {
    const detail = situationText(error, 400);
    logger.warn(
      { err: situationText(error, 200) },
      'ccusage is enabled but its adapter was not built: the daemon works with the signals alone',
    );
    situations.record('usage.notice', {
      kind: 'ccusage_unavailable',
      sessionId: null,
      profile: null,
      ...(detail === null ? {} : { detail }),
    });
    return undefined;
  }
}

function overrideRecord(port: PortName, portVersion: string): AdapterRecord {
  return { port, id: 'override', range: `^${portVersion}`, portVersion };
}

/**
 * The guard against a test that reaches the real keyring (N243, item 64). The default of
 * `adapters.vault` is `keyring`, so a test of the CLI or of the composition that hands in no vault
 * would read and write the keyring of whoever runs the suite (a first version of a Phase 9 test
 * may have left a key there). Under the test runner (`VITEST` is set) the composition refuses the
 * real keyring unless `OT_TEST_KEYRING=1` says the run is the one that is meant to use it (the
 * integration test of the adapter). A test hands in `overrides.vault` or picks `encrypted-file`.
 * Outside the test runner nothing changes. `env` is a parameter so the guard itself is tested
 * without touching anything real.
 */
export function assertRealKeyringAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VITEST === undefined || env.VITEST === '') return;
  if (env.OT_TEST_KEYRING === '1') return;
  throw new InvalidInput(
    'The real keyring was asked for under the test runner: a test must not read or write the keyring of the machine. ' +
      'Hand in a vault (`overrides.vault`, for example an `InMemorySecretVault`) or set `adapters.vault: encrypted-file`; ' +
      'only the run that tests the keyring itself sets OT_TEST_KEYRING=1.',
  );
}

/**
 * The vault the configuration names (`adapters.vault`), or the one a test hands in. Used by
 * {@link compose} and by `ot plugin secret set`, which needs the vault and nothing else of the
 * composition (Phase 9, P7). The returned record is the adapter's, for the list of adapters.
 */
export function composeVault(
  config: DaemonConfig,
  dataDir: string,
  overrides: ComposeOverrides = {},
): { readonly vault: SecretVault; readonly record: AdapterRecord } {
  if (overrides.vault !== undefined) {
    return {
      vault: overrides.vault,
      record: overrideRecord('SecretVault', SECRET_VAULT_PORT_VERSION),
    };
  }
  if (config.adapters.vault === 'keyring') {
    assertRealKeyringAllowed();
    return {
      vault: new KeyringVault(parseSection('vault', KeyringVaultConfigSchema, config.vault)),
      record: checkAdapterRange(keyringVaultAdapter, 'SecretVault', SECRET_VAULT_PORT_VERSION),
    };
  }
  const record = checkAdapterRange(
    encryptedFileVaultAdapter,
    'SecretVault',
    SECRET_VAULT_PORT_VERSION,
  );
  const raw = config.vault;
  const path = typeof raw.path === 'string' ? resolve(dataDir, raw.path) : raw.path;
  const section = parseSection('vault', EncryptedFileVaultConfigSchema, {
    ...raw,
    path: raw.path === undefined ? resolve(dataDir, DEFAULT_VAULT_FILE) : path,
  });
  return { vault: new EncryptedFileVault(section), record };
}

/**
 * The composition point (architecture 5.18, "Montagem, sem container"): the only file of the
 * daemon that imports adapters. It reads `adapters.*` from the config, validates each adapter's
 * section with that adapter's own schema, checks the contract version of every adapter and hands
 * the rest of the daemon plain ports.
 *
 * `overrides` replace an adapter by an instance (tests build the same daemon over `InMemoryStore`,
 * `FakeClock` and `InMemorySecretVault`); they are recorded with the id `override`.
 */
export async function compose(config: DaemonConfig, options: ComposeOptions): Promise<Composition> {
  const overrides = options.overrides ?? {};
  const paths = dataPaths(options.dataDir, overrides.profileDir);
  const adapters: AdapterRecord[] = [];
  let store: Store | undefined;
  let vault: SecretVault | undefined;
  let daemonLogger: DaemonLogger | undefined;

  try {
    // Clock first: the log stamps its lines with it.
    let clock: Clock;
    if (overrides.clock !== undefined) {
      clock = overrides.clock;
      adapters.push(overrideRecord('Clock', CLOCK_PORT_VERSION));
    } else {
      adapters.push(checkAdapterRange(systemClockAdapter, 'Clock', CLOCK_PORT_VERSION));
      clock = new SystemClock();
    }

    // P8: a rotation of `daemon.log` can fail before the situations exist; the error waits here.
    const rotateErrors: unknown[] = [];
    const rotate: { notice?: (error: unknown) => void } = {};
    let logger = options.logger;
    if (logger === undefined) {
      daemonLogger = createLogger({
        level: config.log.level,
        destination: config.log.destination,
        logFile: paths.logFile,
        clock,
        // P8: `daemon.log` rotates by size; a failure is a notice once the situations exist.
        rotate:
          config.log.rotate.mode === 'size'
            ? { maxBytes: config.log.rotate.max_mb * 1024 * 1024, keep: config.log.rotate.keep }
            : undefined,
        onRotateError: (error) => {
          if (rotate.notice === undefined) rotateErrors.push(error);
          else rotate.notice(error);
        },
      });
      logger = daemonLogger.logger;
    }

    const composedVault = composeVault(config, paths.dataDir, overrides);
    vault = composedVault.vault;
    adapters.push(composedVault.record);

    if (overrides.store !== undefined) {
      store = overrides.store;
      adapters.push(overrideRecord('Store', STORE_PORT_VERSION));
    } else {
      adapters.push(checkAdapterRange(SQLITE_STORE_ADAPTER, 'Store', STORE_PORT_VERSION));
      store = await SqliteStore.open(storeSection(config, paths), clock);
    }

    // Phase 6, P2: the hub is the innermost decorator, so every `append` that reaches the adapter
    // (validated or not) is announced after the commit, and one the registry refuses never is.
    const eventHub = createEventHub(store, {
      bufferEvents: config.api.sse.buffer_events,
      logger,
    });
    store = eventHub.store;
    // N80: every `append` of the daemon goes through the event registry.
    const rawStore = store;
    if (options.events !== undefined) {
      store = validateEventsOf(store, { ...options.events, logger });
    }
    // Phase 6, P7: a decision for the Producer also writes its `chat.ask` event (the chat socket's feed).
    // Phase 7, P1 (N173): the decisions, demands and scenarios write the events the client stores are
    // built from. Inside `chatFeedStore`, so `decision.created` comes before `chat.ask`.
    store = chatFeedStore(recordFeedStore(store, logger), logger);

    const vcs = overrides.vcs ?? defaultVcs();
    const launcherChoice: LauncherChoice =
      overrides.launcher === undefined
        ? chooseLauncher(config.processes, overrides.launcherDeps)
        : { launcher: overrides.launcher };
    const { launcher } = launcherChoice;
    const memory = overrides.memory ?? defaultMemoryProbe();
    const transport =
      overrides.transport ??
      new AcpTransport({ terminalOutput: () => config.events.terminal_output !== 'off' });
    // P24 (N146): what the daemon only wrote to the log is also an event. Closed until the daemon
    // wrote `daemon.started`, so what compose notices below is written after it.
    const situations = new SituationLog({ events: store.events, logger });
    // P8: the rotations that failed before the situations existed, and the ones after.
    rotate.notice = (error) => {
      situations.record('daemon.notice', {
        kind: 'log_rotate_failed',
        subject: 'daemon.log',
        detail: situationText(error),
      });
    };
    for (const error of rotateErrors.splice(0)) rotate.notice(error);
    // Phase 10, P2: `processes.windows_launcher: auto` found no `ot-job-launcher.exe`. Daemon.ts tells the
    // effect (`execution_off`, `no_launcher`); this tells the cause, in the log and as an event.
    if (launcherChoice.fallback !== undefined) {
      logger.warn(launcherChoice.fallback);
      situations.record('daemon.notice', {
        kind: 'execution_off',
        subject: 'windows_launcher_not_found',
        detail: situationText(launcherChoice.fallback),
      });
    }
    const sandbox = await composeSandbox(config, paths, overrides, logger, situations);
    const browser =
      overrides.browser ?? defaultBrowser(config, paths.profiles, launcher, logger, situations);

    const usageSource = composeUsageSource(config, paths, overrides, adapters, logger, situations);

    // Phase 8, P1 (N54): the telemetry base opens after the situations, which it reports to. It
    // never stops the daemon: a bad file is recreated, and a base that cannot be had is `no_base`.
    let telemetry: TelemetryStore | undefined;
    let telemetryBackup: Composition['telemetryBackup'];
    if (overrides.telemetry === 'none' || config.telemetry.enabled === 'off') {
      telemetry = undefined;
    } else if (overrides.telemetry !== undefined) {
      telemetry = overrides.telemetry;
      adapters.push(overrideRecord('TelemetryStore', TELEMETRY_STORE_PORT_VERSION));
    } else {
      adapters.push(
        checkAdapterRange(SQLITE_TELEMETRY_ADAPTER, 'TelemetryStore', TELEMETRY_STORE_PORT_VERSION),
      );
      const sqlite = await SqliteTelemetryStore.open(
        telemetrySection(config, paths.dataDir, paths),
        { clock, onReset: telemetryResetHandler(logger, situations) },
      );
      telemetry = sqlite;
      telemetryBackup = async (dest) => {
        if ((await sqlite.health()).state === 'no_base') return false;
        await sqlite.backupTo(dest);
        return true;
      };
    }

    // Phase 8, P4 (N214 (a)): the spans of the daemon, read from the event log. Started by the daemon.
    const daemonSpans =
      telemetry !== undefined && config.telemetry.daemon_spans.enabled === 'on'
        ? new DaemonSpans({
            telemetry,
            hub: eventHub,
            events: store.events,
            clock,
            logger,
            situations,
            waits: config.telemetry.daemon_spans.waits,
          })
        : undefined;

    // Phase 8, P15 (N222 (a)): the waits of the queue of prompts and of the pool, told in the log.
    const waitEvents =
      config.events.wait_threshold === null
        ? undefined
        : new WaitEvents({ situations, clock, thresholdMs: config.events.wait_threshold });

    const opened = { store, vault, sandbox, browser, situations, eventHub, telemetry };
    let closing: Promise<void> | undefined;
    return {
      clock,
      store,
      rawStore,
      eventHub,
      vault,
      logger,
      adapters,
      vcs,
      launcher,
      memory,
      transport,
      sandbox,
      browser,
      codeHost: overrides.codeHost,
      usageSource,
      situations,
      telemetry,
      telemetryBackup,
      daemonSpans,
      waitEvents,
      close: () => (closing ??= closeParts(opened, daemonLogger, logger)),
    };
  } catch (error) {
    await closeParts({ store, vault, sandbox: undefined }, daemonLogger, undefined).catch(
      () => undefined,
    );
    throw error;
  }
}

async function closeParts(
  parts: {
    store: Store | undefined;
    vault: SecretVault | undefined;
    sandbox: SandboxWiring | undefined;
    browser?: BrowserSession | undefined;
    situations?: SituationLog | undefined;
    eventHub?: EventHub | undefined;
    telemetry?: TelemetryStore | undefined;
  },
  daemonLogger: DaemonLogger | undefined,
  logger: Logger | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await parts.browser?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await parts.sandbox?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    // Writes what is queued; it may still report a reset, which is a situation, so it goes first.
    await parts.telemetry?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    // The situations still being written use the store: they finish before it closes.
    await parts.situations?.idle();
    // The streams end before the store they read from closes.
    parts.eventHub?.close();
    await parts.store?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (parts.vault !== undefined && isLockableSecretVault(parts.vault)) await parts.vault.lock();
  } catch (error) {
    failures.push(error);
  }
  daemonLogger?.close();
  if (failures.length > 0) {
    logger?.error({ err: failures }, 'closing the composition failed');
    throw failures[0];
  }
}

/**
 * What `ot backup` (daemon running, so the store is not ours to open) and `ot restore` need from
 * the store adapter: operations on the database **file**. The rest of the daemon cannot import
 * the adapter, so this is how it reaches them.
 */
export interface StoreFileTools {
  /** Absolute path of the database file. */
  readonly databasePath: string;
  /** Consistent copy of the live file (safe with another process writing); same rules as `StoreMaintenance.backup`. */
  backupFile(dest: string, options?: StoreBackupOptions): Promise<StoreBackupResult>;
  /** Replaces the database with `backupPath` (store closed, instance lock held); keeps the old one aside. */
  restoreFile(
    backupPath: string,
    clock: Pick<Clock, 'now'>,
  ): Promise<{ databasePath: string; previousDatabase: string | undefined; bytes: number }>;
}

export function composeStoreFileTools(config: DaemonConfig, dataDir: string): StoreFileTools {
  const paths = dataPaths(dataDir);
  const section = storeSection(config, paths);
  return {
    databasePath: paths.store,
    backupFile: (dest, options = {}) =>
      backupDatabase({
        driver: section.driver,
        sourcePath: paths.store,
        destPath: dest,
        busyTimeoutMs: section.busyTimeoutMs,
        ...(options.method === undefined ? {} : { method: parseBackupMethod(options.method) }),
        ...(options.pagesPerStep === undefined ? {} : { pagesPerStep: options.pagesPerStep }),
      }),
    restoreFile: (backupPath, clock) =>
      restoreDatabase({
        driver: section.driver,
        backupPath,
        databasePath: paths.store,
        clock,
        busyTimeoutMs: section.busyTimeoutMs,
      }),
  };
}

/**
 * Only the clock, for commands that must not open the store (`ot restore` runs with the store
 * closed). Same adapter, same contract check as {@link compose}.
 */
export function composeClock(overrides: ComposeOverrides = {}): Clock {
  if (overrides.clock !== undefined) return overrides.clock;
  checkAdapterRange(systemClockAdapter, 'Clock', CLOCK_PORT_VERSION);
  return new SystemClock();
}

/**
 * The executable each client starts when `clients.<id>.command` is not set, and what to search in
 * `PATH` for `enabled: auto`. They come from the adapters; OpenCode exports no constant for it.
 */
export const DEFAULT_CLIENT_EXECUTABLES: Readonly<Record<ClientId, string>> = {
  'claude-code': CLAUDE_DEFAULT_COMMAND.cmd,
  codex: DEFAULT_CODEX_COMMAND.cmd,
  opencode: 'opencode',
};

/**
 * The npm packages `version_source` looks for next to each client's executable (N63):
 * the ACP adapter for Claude Code and Codex, the client itself for OpenCode.
 */
export const VERSION_PACKAGES: Readonly<Record<ClientId, readonly string[]>> = {
  'claude-code': CLAUDE_CODE_ACP_PACKAGES,
  codex: CODEX_ACP_PACKAGES,
  opencode: OPENCODE_PACKAGES,
};

/** [proposta] Arguments `clients.opencode.command` takes when it names only `cmd`. */
const OPENCODE_DEFAULT_ARGS: readonly string[] = ['acp'];

/** [proposta] Version of the Codex adapter's translation; the adapter exports no constant for it yet. */
const CODEX_ADAPTER_VERSION = '0.1.0';

export interface ProductionClientsOptions {
  /** The environment the clients' own is built from, and the `PATH` that is searched. Default `process.env`. */
  readonly env?: Env;
  /** Replaces the search of `PATH` for `enabled: auto` (tests say what is installed). */
  readonly findExecutable?: FindExecutable;
  /**
   * How the Claude catalog reads the config options of a fresh session. Without it the daemon
   * wires {@link sessionConfigReader} (a session without a prompt, read-only role, in
   * `<data>/catalog-probe`), unless `clients.claude-code.model_catalog` is `reserve`.
   */
  readonly claudeConfigOptions?: ConfigOptionsReader;
  /**
   * The same for the Codex catalog. Without it the daemon wires {@link sessionConfigReader},
   * unless `clients.codex.model_catalog` is `none` (then `models.list` of Codex rejects).
   */
  readonly codexConfigSource?: CodexConfigSource;
  /**
   * Test seams of the managed ACP adapters (P13): the `fetch` that reaches the registry, the
   * platform the install is for, how the program starts itself, and the waits of the installer.
   */
  readonly adapters?: Pick<
    AdapterManagerOptions,
    'fetch' | 'platform' | 'self' | 'installOptions' | 'lockOf'
  >;
}

function minLayersOf(security: DaemonConfig['security']): MinLayers {
  const layers: { default: number } & Partial<Record<(typeof ROLE_POLICY_FIELDS)[number], number>> =
    { default: security.min_layers.default };
  for (const field of ROLE_POLICY_FIELDS) {
    const value = security.min_layers[field];
    if (value !== undefined) layers[field] = value;
  }
  return layers;
}

/**
 * What the three adapters take alike (`ClientAdapterOptions`). The adapter version is built from
 * the client version (`adapterVersionOf`), and follows it when the `initialize` of a session
 * corrects it (N63); the warning log keys its "once per client and adapter version" by the version
 * the adapter has at the time of the warning.
 */
function commonOptions(
  config: DaemonConfig,
  section: Parameters<typeof buildClientEnv>[0],
  env: Env,
  parts: ClientFactoryParts,
  warnings: ClientWarningLog,
  versioning: ClientVersioning,
  adapterVersionOf: (clientVersion: string) => string,
  client: ClientId,
  managedEnv: Readonly<Record<string, string>> = {},
): ClientAdapterOptions {
  let adapterVersion = adapterVersionOf(versioning.initial.version);
  return {
    adapterVersion,
    clientVersion: { ...versioning, adapterVersionOf },
    launcher: parts.launcher,
    // `K` for the use of the adapter without the pool above it: the same value the pool uses.
    sessionsPerProcess: sessionsPerProcessOf(config.pool, client),
    // `managedEnv` (the official client for the ACP adapter, P13) goes first: the user's own env wins.
    baseEnv: { ...managedEnv, ...buildClientEnv(section, env) },
    minLayers: minLayersOf(config.security),
    unenforced: config.security.unenforced,
    ...(parts.sandbox === undefined
      ? {}
      : { sandbox: parts.sandbox.capabilities, launchWrapper: parts.sandbox.launchWrapper }),
    ...(parts.secretEnv === undefined ? {} : { secretEnv: parts.secretEnv }),
    catalogProbe: config.security.catalog_probe,
    conformance: config.security.conformance,
    onWarning: (warning: ClientAdapterWarning) => {
      if (warning.kind === 'client_version_corrected') adapterVersion = warning.adapterVersion;
      warnings(warning, adapterVersion);
    },
  };
}

/** The adapter a reader was built for; a reader runs only after the factory returned it. */
function built(adapter: ClientAdapter | undefined): ClientAdapter {
  if (adapter === undefined) throw new AdapterUnavailable('the client adapter is not built yet');
  return adapter;
}

function claudeCode(
  config: DaemonConfig,
  env: Env,
  parts: ClientFactoryParts,
  warnings: ClientWarningLog,
  versioning: ClientVersioning,
  options: ProductionClientsOptions,
  adapters: AdapterManager,
): ClientAdapter {
  const section = config.clients['claude-code'];
  const command = section.command;
  // The reader needs the adapter that is built with it: it looks the adapter up when it runs.
  const own: { adapter?: ClientAdapter } = {};
  const reader: ConfigOptionsReader | undefined =
    options.claudeConfigOptions ??
    (section.model_catalog === 'reserve'
      ? undefined
      : sessionConfigReader({
          adapter: () => built(own.adapter),
          via: () => parts.transport,
          paths: parts.paths,
        }));
  const adapter = new ClaudeCodeAdapter({
    ...commonOptions(
      config,
      section,
      env,
      parts,
      warnings,
      versioning,
      (clientVersion) =>
        adapterVersionOf(CLAUDE_CODE_ADAPTER_VERSION, 'claude-code', clientVersion),
      'claude-code',
      adapters.officialEnv('claude-code'),
    ),
    command:
      command === undefined
        ? () => adapters.commandFor('claude-code', section.adapter)
        : { cmd: command.cmd, args: command.args ?? CLAUDE_DEFAULT_COMMAND.args },
    settingSources: section.setting_sources,
    utilizationUnit: section.utilization_unit,
    quotaStatusline: section.quota_statusline,
    profileDir: (ref) => profileDirOf(parts.paths, ref),
    accountEnv: section.account_env,
    modelCatalog: {
      source: section.model_catalog,
      cacheMs: section.model_catalog_cache,
      ...(reader === undefined ? {} : { reader }),
    },
  });
  own.adapter = adapter;
  return adapter;
}

function codex(
  config: DaemonConfig,
  env: Env,
  parts: ClientFactoryParts,
  warnings: ClientWarningLog,
  versioning: ClientVersioning,
  options: ProductionClientsOptions,
  adapters: AdapterManager,
): ClientAdapter {
  const section = config.clients.codex;
  const command = section.command;
  const own: { adapter?: ClientAdapter } = {};
  const source: CodexConfigSource | undefined =
    options.codexConfigSource ??
    (section.model_catalog === 'none'
      ? undefined
      : sessionConfigReader({
          adapter: () => built(own.adapter),
          via: () => parts.transport,
          paths: parts.paths,
        }));
  const adapter = new CodexAdapter({
    ...commonOptions(
      config,
      section,
      env,
      parts,
      warnings,
      versioning,
      (clientVersion) => adapterVersionOf(CODEX_ADAPTER_VERSION, 'codex', clientVersion),
      'codex',
      adapters.officialEnv('codex'),
    ),
    command:
      command === undefined
        ? () => adapters.commandFor('codex', section.adapter)
        : { cmd: command.cmd, args: command.args ?? DEFAULT_CODEX_COMMAND.args },
    processModel: section.process_model,
    initialMode: section.initial_mode,
    allowedModes: section.modes,
    credentialsStore: section.credentials_store,
    approvalPolicy: section.approval_policy,
    innerSandbox: section.inner_sandbox,
    suggestedEffort: section.suggested_effort,
    quota: {
      profileDir: (ref) => profileDirOf(parts.paths, ref),
      ...(section.quota.command === undefined
        ? {}
        : {
            command: {
              cmd: section.quota.command.cmd,
              args: section.quota.command.args ?? DEFAULT_QUOTA_COMMAND.args,
            },
          }),
      timeoutMs: section.quota.timeout,
      watch: section.quota.watch,
      windows: section.quota.windows,
    },
    ...(source === undefined ? {} : { modelSource: source }),
  });
  own.adapter = adapter;
  if (section.inner_sandbox !== 'keep') {
    const layer3 = parts.sandbox !== undefined;
    parts.logger.info(
      {
        client: 'codex',
        inner_sandbox: section.inner_sandbox,
        layer3,
        initial_mode: adapter.initialMode,
      },
      layer3
        ? `clients.codex.inner_sandbox is ${section.inner_sandbox}`
        : `clients.codex.inner_sandbox is ${section.inner_sandbox}, but layer 3 is off: it behaves as keep`,
    );
  }
  return adapter;
}

function opencode(
  config: DaemonConfig,
  env: Env,
  parts: ClientFactoryParts,
  warnings: ClientWarningLog,
  versioning: ClientVersioning,
): ClientAdapter {
  const section = config.clients.opencode;
  const command = section.command;
  return new OpenCodeAdapter({
    ...commonOptions(
      config,
      section,
      env,
      parts,
      warnings,
      versioning,
      opencodeAdapterVersion,
      'opencode',
    ),
    ...(command === undefined
      ? {}
      : { command: { cmd: command.cmd, args: command.args ?? OPENCODE_DEFAULT_ARGS } }),
    // N56: the pool section decides how OpenCode shares its processes.
    processModel: config.pool.opencode.process_model,
    // P8: the local accounting of the OpenCode quota (`ledger`, and `auto` for the profiles with
    // no `codex_link`, P25); with no limit configured it stays without windows.
    ...(config.quota.opencode.mode === 'ledger' || config.quota.opencode.mode === 'auto'
      ? {
          ledger: {
            clock: parts.clock,
            windowMs: config.quota.opencode.window,
            limitTokens: config.quota.opencode.limit_tokens,
            limitUsd: config.quota.opencode.limit_usd,
          },
        }
      : {}),
    isolation: section.isolation,
    ...(section.profile_config === undefined ? {} : { profileConfig: section.profile_config }),
    shellKeys: section.shell_keys,
    internalTools: section.internal_tools,
    projectConfig: section.project_config,
    readOnlyMode: section.read_only_mode,
    profileDir: (ref) => profileDirOf(parts.paths, ref),
    catalog: {
      cacheMs: section.models_cache,
      effortPreference: section.suggest.effort_preference,
      contextSeverity: section.context_severity,
      ...(section.min_context_window === undefined
        ? {}
        : { minContextWindow: section.min_context_window }),
    },
    permissionProbe: {
      via: parts.transport,
      scratchRoot: parts.paths.scratch,
      timeoutMs: section.permission_probe.timeout,
      ...(section.permission_probe.model === undefined
        ? {}
        : { model: section.permission_probe.model }),
    },
    slotTimeoutMs: section.slot_timeout,
  });
}

/**
 * The `ClientFactory` of the product: builds the clients `clients.*` turns on (architecture 5.2,
 * 5.18). A client is on when `enabled` says so, or, with `auto`, when its `command` is set or its
 * executable is in `PATH`; the search never runs the binary. The daemon depends on the three
 * adapter packages and never on the executables (level C, N45): a client that is not installed is
 * simply left out. The version of a client is never asked of it: it is `client_version`, the
 * `package.json` of the installed package, or what the client says in its `initialize` (N63,
 * `version_source`).
 *
 * Each adapter gets the launcher of the daemon, an environment built from `env` by the client's
 * `env_*` keys, the `security.*` values and its own keys. Nothing here reads a token.
 */
export function productionClients(
  config: DaemonConfig,
  options: ProductionClientsOptions = {},
): ClientFactory {
  const env: Env = options.env ?? process.env;
  const find = options.findExecutable ?? pathFinder(env);
  return (parts) => {
    const adapters: ClientAdapter[] = [];
    const warnings = clientWarningLog(
      config.security.catalog_probe_log,
      parts.logger,
      parts.situations,
    );
    const managed = new AdapterManager({
      adaptersDir: parts.paths.adapters,
      install: config.clients.adapters.install,
      registry: config.clients.adapters.registry,
      find,
      logger: parts.logger,
      situations: parts.situations,
      ...options.adapters,
    });
    const probe: ManagedProbeFn = (id) => {
      if (!isManagedClient(id)) return undefined;
      const status = managed.status(id);
      return {
        entry: status.entry,
        installed: status.installed,
        officialPath: status.officialPath,
        installsByItself: managed.installsByItself,
      };
    };
    const needing: ManagedClientId[] = [];
    for (const selection of selectClients(config, DEFAULT_CLIENT_EXECUTABLES, find, probe)) {
      const { id, reason, executable } = selection;
      if (reason === 'forced_not_found') {
        parts.logger.warn(
          { client: id, executable },
          'client is enabled but its executable is not in PATH; its sessions will fail to start',
        );
        parts.situations?.record('daemon.notice', {
          kind: 'client_not_found',
          subject: situationSubject(id),
          detail: situationText(executable),
        });
      } else {
        parts.logger.info({ client: id, enabled: selection.enabled, reason, executable }, 'client');
      }
      if (
        isManagedClient(id) &&
        config.clients[id].adapter === 'managed' &&
        reason !== 'disabled'
      ) {
        if (selection.enabled || reason === 'adapter_missing') needing.push(id);
      }
      if (!selection.enabled) continue;
      const section = config.clients[id];
      const versioning = resolveClientVersioning({
        mode: section.version_source,
        written: section.client_version,
        command: executable,
        packages: section.version_packages ?? VERSION_PACKAGES[id],
        // The installed managed adapter is a script that is not in `PATH` (nor executable): its own path.
        find: (command) =>
          reason === 'managed_installed' && command === executable ? command : find(command),
      });
      parts.logger.info(
        { client: id, version: versioning.initial.version, source: versioning.initial.source },
        'client version',
      );
      adapters.push(
        id === 'claude-code'
          ? claudeCode(config, env, parts, warnings, versioning, options, managed)
          : id === 'codex'
            ? codex(config, env, parts, warnings, versioning, options, managed)
            : opencode(config, env, parts, warnings, versioning),
      );
    }
    // P13: the adapter of a client that is on installs in the background (`install: auto`) or is told as missing.
    managed.prepare(needing);
    return adapters;
  };
}

/** Re-exported for the tests of the Executor cadastro (only compose.ts may import adapters, 5.18). */
export { OpenCodeModelCatalog } from '@otheater/adapter-client-opencode';

/**
 * The schemas this daemon has, as the manifest of a release says them (`schemas.store`,
 * `schemas.telemetry`): the number of the newest migration of each base (Phase 10, P8). [proposta]
 * A new version whose number is larger will migrate the base when it starts, so the backup is made
 * first. It lives here because only this file may import the adapters.
 */
export function composeOwnSchemas(): OwnSchemas {
  return {
    store: newestMigration(STORE_MIGRATIONS),
    telemetry: newestMigration(TELEMETRY_MIGRATIONS),
  };
}
