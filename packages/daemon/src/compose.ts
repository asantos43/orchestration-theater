// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  ClaudeCodeAdapter,
  DEFAULT_COMMAND as CLAUDE_DEFAULT_COMMAND,
  type ConfigOptionsReader,
} from '@otheater/adapter-client-claude-code';
import {
  CodexAdapter,
  DEFAULT_CODEX_COMMAND,
  type CodexConfigSource,
} from '@otheater/adapter-client-codex';
import { OpenCodeAdapter, opencodeAdapterVersion } from '@otheater/adapter-client-opencode';
import { SystemClock, systemClockAdapter } from '@otheater/adapter-clock-system';
import {
  POSIX_PROCESS_LAUNCHER_ADAPTER,
  PosixProcessLauncher,
} from '@otheater/adapter-platform-posix';
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
  CLOCK_PORT_VERSION,
  InvalidInput,
  isLockableSecretVault,
  PROCESS_LAUNCHER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  SECRET_VAULT_PORT_VERSION,
  STORE_PORT_VERSION,
  VCS_PORT_VERSION,
  type Adapter,
  type ClientAdapter,
  type ClientAdapterOptions,
  type ClientAdapterWarning,
  type Clock,
  type MinLayers,
  type ProcessLauncher,
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
import { sessionConfigReader } from './catalog-reader.js';
import { clientWarningLog, type ClientWarningLog } from './client-warnings.js';
import { describeZodError, type ClientId, type DaemonConfig } from './config.js';
import { createLogger, type DaemonLogger, type Logger } from './logger.js';
import { dataPaths, profileDirOf, type DataPaths, type Env } from './paths.js';

/** The ports the daemon composes. */
export type PortName = 'Store' | 'SecretVault' | 'Clock' | 'Vcs' | 'ProcessLauncher';

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
  /** The wire the sessions speak (`AcpTransport` by default). */
  readonly transport?: SessionTransport;
}

export interface ComposeOptions {
  readonly dataDir: string;
  readonly overrides?: ComposeOverrides;
  /** Use this logger instead of building one from `config.log` (it is not closed by `close()`). */
  readonly logger?: Logger;
}

export interface Composition {
  readonly clock: Clock;
  readonly store: Store;
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
  readonly transport: SessionTransport;
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

    const vcs = overrides.vcs ?? defaultVcs();
    const launcher = overrides.launcher ?? defaultLauncher();
    const transport = overrides.transport ?? new AcpTransport();

    const opened = { store, vault };
    let closing: Promise<void> | undefined;
    return {
      clock,
      store,
      vault,
      logger,
      adapters,
      vcs,
      launcher,
      transport,
      close: () => (closing ??= closeParts(opened, daemonLogger, logger)),
    };
  } catch (error) {
    await closeParts({ store, vault }, daemonLogger, undefined).catch(() => undefined);
    throw error;
  }
}

async function closeParts(
  parts: { store: Store | undefined; vault: SecretVault | undefined },
  daemonLogger: DaemonLogger | undefined,
  logger: Logger | undefined,
): Promise<void> {
  const failures: unknown[] = [];
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

/** What the three adapters take alike (`ClientAdapterOptions`). */
function commonOptions(
  config: DaemonConfig,
  section: Parameters<typeof buildClientEnv>[0],
  env: Env,
  parts: ClientFactoryParts,
  warnings: ClientWarningLog,
  adapterVersion: string,
): ClientAdapterOptions {
  return {
    adapterVersion,
    launcher: parts.launcher,
    baseEnv: buildClientEnv(section, env),
    minLayers: minLayersOf(config.security),
    unenforced: config.security.unenforced,
    catalogProbe: config.security.catalog_probe,
    conformance: config.security.conformance,
    onWarning: (warning: ClientAdapterWarning) => {
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
          via: (target) => transportFor(target, parts.transport),
          paths: parts.paths,
        }));
  const adapter = new ClaudeCodeAdapter({
    ...commonOptions(
      config,
      section,
      env,
      parts,
      warnings,
      adapterVersionOf(CLAUDE_CODE_ADAPTER_VERSION, 'claude-code', section.client_version),
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
          via: (target) => transportFor(target, parts.transport),
          paths: parts.paths,
        }));
  const adapter = new CodexAdapter({
    ...commonOptions(
      config,
      section,
      env,
      parts,
      warnings,
      adapterVersionOf(CODEX_ADAPTER_VERSION, 'codex', section.client_version),
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
      opencodeAdapterVersion(section.client_version),
    ),
    ...(command === undefined
      ? {}
      : { command: { cmd: command.cmd, args: command.args ?? OPENCODE_DEFAULT_ARGS } }),
    // N56: the pool section decides how OpenCode shares its processes.
    processModel: config.pool.opencode.process_model,
    isolation: section.isolation,
    ...(section.profile_config === undefined ? {} : { profileConfig: section.profile_config }),
    shellKeys: section.shell_keys,
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
 * simply left out. The version of a client is never asked of it: it is `client_version` or `unknown`.
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
      adapters.push(
        id === 'claude-code'
          ? claudeCode(config, env, parts, warnings, options)
          : id === 'codex'
            ? codex(config, env, parts, warnings, options)
            : opencode(config, env, parts, warnings),
      );
    }
    return adapters;
  };
}

const guardedTransports = new WeakMap<
  ClientAdapter,
  { readonly base: SessionTransport; readonly guarded: SessionTransport }
>();

/**
 * The transport a client's sessions go through: the base one, except for Codex, whose adapter
 * wraps it to veto the `agent` and `agent-full-access` modes (architecture 5.8). The wrapper is
 * kept per adapter, so every session of a client shares one.
 */
export function transportFor(adapter: ClientAdapter, base: SessionTransport): SessionTransport {
  if (!(adapter instanceof CodexAdapter)) return base;
  const known = guardedTransports.get(adapter);
  if (known?.base === base) return known.guarded;
  const guarded = adapter.guardTransport(base);
  guardedTransports.set(adapter, { base, guarded });
  return guarded;
}
