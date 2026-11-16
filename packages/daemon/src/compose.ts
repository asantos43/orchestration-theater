// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { SystemClock, systemClockAdapter } from '@otheater/adapter-clock-system';
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
import {
  AdapterUnavailable,
  CLOCK_PORT_VERSION,
  InvalidInput,
  isLockableSecretVault,
  SECRET_VAULT_PORT_VERSION,
  STORE_PORT_VERSION,
  type Adapter,
  type Clock,
  type SecretVault,
  type Store,
  type StoreBackupOptions,
  type StoreBackupResult,
} from '@otheater/core';
import semver from 'semver';
import { z } from 'zod';
import { describeZodError, type DaemonConfig } from './config.js';
import { createLogger, type DaemonLogger, type Logger } from './logger.js';
import { dataPaths, type DataPaths } from './paths.js';

/** The ports the daemon composes. */
export type PortName = 'Store' | 'SecretVault' | 'Clock';

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

    const opened = { store, vault };
    let closing: Promise<void> | undefined;
    return {
      clock,
      store,
      vault,
      logger,
      adapters,
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
