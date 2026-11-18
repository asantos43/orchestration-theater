// SPDX-License-Identifier: MPL-2.0
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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
import { SRT_SANDBOX_ADAPTER, SrtSandbox } from '@otheater/adapter-sandbox-srt';
import { AcpTransport } from '@otheater/adapter-session-acp';
import {
  backupDatabase,
  parseBackupMethod,
  restoreDatabase,
  SQLITE_STORE_ADAPTER,
  SqliteStore,
  SqliteStoreConfigSchema,
  type SqliteStoreConfig,
} from '@otheater/adapter-store-sqlite';
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
  type StoreBackupOptions,
  type StoreBackupResult,
  type Vcs,
} from '@otheater/core';
import semver from 'semver';
import { z } from 'zod';
import {
  adapterVersionOf,
  buildClientEnv,
  pathFinder,
  selectClients,
  type ClientFactory,
  type ClientFactoryParts,
  type FindExecutable,
} from './clients.js';
import { resolveClientVersioning, type ClientVersioning } from './client-version.js';
import { sessionConfigReader } from './catalog-reader.js';
import { clientWarningLog, type ClientWarningLog } from './client-warnings.js';
import {
  describeZodError,
  sessionsPerProcessOf,
  type ClientId,
  type DaemonConfig,
} from './config.js';
import { validateEventsOf, type EventValidation } from './event-validation.js';
import { createLogger, type DaemonLogger, type Logger } from './logger.js';
import { dataPaths, profileDirOf, type DataPaths, type Env } from './paths.js';
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
  | 'MemoryProbe';

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
  readonly vault?: SecretVault;
  /** Version control for the worktrees of the attempts (`GitVcs` by default). */
  readonly vcs?: Vcs;
  /** Starts the adapter processes (`PosixProcessLauncher` by default; none on Windows yet). */
  readonly launcher?: ProcessLauncher;
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
   * instance as `store` when `events` is not set.
   */
  readonly rawStore: Store;
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

/** The process launcher of this platform, or `undefined` where there is none yet. */
export function defaultLauncher(): ProcessLauncher | undefined {
  if (process.platform === 'win32') return undefined;
  checkAdapterRange(
    POSIX_PROCESS_LAUNCHER_ADAPTER,
    'ProcessLauncher',
    PROCESS_LAUNCHER_PORT_VERSION,
  );
  return new PosixProcessLauncher();
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
): Promise<SandboxWiring | undefined> {
  if (overrides.sandbox === 'none' || config.sandbox.mode === 'off') {
    logger.info(
      { mode: config.sandbox.mode },
      'sandbox is off: writeScope and network have no layer, security.unenforced decides',
    );
    return undefined;
  }
  let sandbox: Sandbox;
  if (overrides.sandbox !== undefined) {
    sandbox = overrides.sandbox;
    const availability = await sandbox.available();
    if (!availability.ok) {
      logger.warn({ reason: availability.reason }, 'sandbox is not available');
      return undefined;
    }
  } else {
    checkAdapterRange(SRT_SANDBOX_ADAPTER, 'Sandbox', SANDBOX_PORT_VERSION);
    const availability = await probeSandbox();
    if (!availability.ok) {
      logger.warn(
        { reason: availability.reason, platform: process.platform },
        'layer 3 (sandbox) is missing here: writeScope and network have no guarantee, security.unenforced decides',
      );
      return undefined;
    }
    sandbox = new SrtSandbox();
  }
  logger.info({ sandbox: sandbox.id, fields: sandbox.capabilities().fields }, 'sandbox');
  return buildSandboxWiring({ sandbox, config, home: homedir(), dataDir: paths.dataDir });
}

function overrideRecord(port: PortName, portVersion: string): AdapterRecord {
  return { port, id: 'override', range: `^${portVersion}`, portVersion };
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
  const paths = dataPaths(options.dataDir);
  const overrides = options.overrides ?? {};
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

    let logger = options.logger;
    if (logger === undefined) {
      daemonLogger = createLogger({
        level: config.log.level,
        destination: config.log.destination,
        logFile: paths.logFile,
        clock,
      });
      logger = daemonLogger.logger;
    }

    if (overrides.vault !== undefined) {
      vault = overrides.vault;
      adapters.push(overrideRecord('SecretVault', SECRET_VAULT_PORT_VERSION));
    } else if (config.adapters.vault === 'keyring') {
      adapters.push(
        checkAdapterRange(keyringVaultAdapter, 'SecretVault', SECRET_VAULT_PORT_VERSION),
      );
      vault = new KeyringVault(parseSection('vault', KeyringVaultConfigSchema, config.vault));
    } else {
      adapters.push(
        checkAdapterRange(encryptedFileVaultAdapter, 'SecretVault', SECRET_VAULT_PORT_VERSION),
      );
      const raw = config.vault;
      const path = typeof raw.path === 'string' ? resolve(paths.dataDir, raw.path) : raw.path;
      const section = parseSection('vault', EncryptedFileVaultConfigSchema, {
        ...raw,
        path: raw.path === undefined ? resolve(paths.dataDir, DEFAULT_VAULT_FILE) : path,
      });
      vault = new EncryptedFileVault(section);
    }

    if (overrides.store !== undefined) {
      store = overrides.store;
      adapters.push(overrideRecord('Store', STORE_PORT_VERSION));
    } else {
      adapters.push(checkAdapterRange(SQLITE_STORE_ADAPTER, 'Store', STORE_PORT_VERSION));
      store = await SqliteStore.open(storeSection(config, paths), clock);
    }

    // N80: every `append` of the daemon goes through the event registry.
    const rawStore = store;
    if (options.events !== undefined) {
      store = validateEventsOf(store, { ...options.events, logger });
    }

    const vcs = overrides.vcs ?? defaultVcs();
    const launcher = overrides.launcher ?? defaultLauncher();
    const memory = overrides.memory ?? defaultMemoryProbe();
    const transport = overrides.transport ?? new AcpTransport();
    const sandbox = await composeSandbox(config, paths, overrides, logger);
    const browser = overrides.browser ?? defaultBrowser(config, paths.profiles, launcher, logger);

    const opened = { store, vault, sandbox, browser };
    let closing: Promise<void> | undefined;
    return {
      clock,
      store,
      rawStore,
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
const VERSION_PACKAGES: Readonly<Record<ClientId, readonly string[]>> = {
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
): ClientAdapterOptions {
  let adapterVersion = adapterVersionOf(versioning.initial.version);
  return {
    adapterVersion,
    clientVersion: { ...versioning, adapterVersionOf },
    launcher: parts.launcher,
    // `K` for the use of the adapter without the pool above it: the same value the pool uses.
    sessionsPerProcess: sessionsPerProcessOf(config.pool, client),
    baseEnv: buildClientEnv(section, env),
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
    ),
    ...(command === undefined
      ? {}
      : { command: { cmd: command.cmd, args: command.args ?? CLAUDE_DEFAULT_COMMAND.args } }),
    settingSources: section.setting_sources,
    utilizationUnit: section.utilization_unit,
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
    ),
    ...(command === undefined
      ? {}
      : { command: { cmd: command.cmd, args: command.args ?? DEFAULT_CODEX_COMMAND.args } }),
    processModel: section.process_model,
    initialMode: section.initial_mode,
    allowedModes: section.modes,
    credentialsStore: section.credentials_store,
    approvalPolicy: section.approval_policy,
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
    const warnings = clientWarningLog(config.security.catalog_probe_log, parts.logger);
    for (const selection of selectClients(config, DEFAULT_CLIENT_EXECUTABLES, find)) {
      const { id, reason, executable } = selection;
      if (reason === 'forced_not_found') {
        parts.logger.warn(
          { client: id, executable },
          'client is enabled but its executable is not in PATH; its sessions will fail to start',
        );
      } else {
        parts.logger.info({ client: id, enabled: selection.enabled, reason, executable }, 'client');
      }
      if (!selection.enabled) continue;
      const section = config.clients[id];
      const versioning = resolveClientVersioning({
        mode: section.version_source,
        written: section.client_version,
        command: executable,
        packages: section.version_packages ?? VERSION_PACKAGES[id],
        find,
      });
      parts.logger.info(
        { client: id, version: versioning.initial.version, source: versioning.initial.source },
        'client version',
      );
      adapters.push(
        id === 'claude-code'
          ? claudeCode(config, env, parts, warnings, versioning, options)
          : id === 'codex'
            ? codex(config, env, parts, warnings, versioning, options)
            : opencode(config, env, parts, warnings, versioning),
      );
    }
    return adapters;
  };
}
