// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  hasErrorCode,
  hasStoreMaintenance,
  isLockableSecretVault,
  PermissionDenied,
  type ClientAdapter,
  type Clock,
  type ProcessLauncher,
  type LockableSecretVault,
  type Secret,
  type SecretVault,
  type Store,
} from '@otheater/core';
import {
  buildDaemonEvent,
  DaemonStatusSchema,
  type BackupTrigger,
  type DaemonState,
  type DaemonStatus,
} from '@otheater/protocol';
import { compose, type Composition, type ComposeOverrides } from './compose.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { Execution } from './execution/service.js';
import type { AttemptResolver } from './execution/reconcile.js';
import { executionSettingsOf } from './execution/settings.js';
import { InstanceLock } from './instance-lock.js';
import type { Logger } from './logger.js';
import { dataPaths, ensureDataDir } from './paths.js';
import { BackupService, type BackupOutcome } from './recovery/backup.js';
import { BackupScheduler, type ActivityProbe } from './recovery/schedule.js';
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

/** What a factory of clients may need to build its adapters. */
export interface ClientFactoryParts {
  readonly launcher: ProcessLauncher;
  readonly clock: Clock;
}

/**
 * Builds the `ClientAdapter`s the daemon executes attempts with. They are injected, not named
 * here: the daemon imports adapters only in `compose.ts` (architecture 5.18). The three real
 * clients are wired by the composition of the product; tests pass the fake.
 */
export type ClientFactory = (parts: ClientFactoryParts) => readonly ClientAdapter[];

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
  /** The clients that run attempts. Without them the daemon starts with the execution off. */
  readonly clients?: ClientFactory | undefined;
  /**
   * Tells the reconciliation what it needs to resume an attempt the daemon did not start (profile,
   * Executor, policy). Without it, the attempts that were running are parked as `interrupted`.
   */
  readonly resolveAttempt?: AttemptResolver | undefined;
}

export type StopReason = 'signal' | 'shutdown' | 'error';

export interface DaemonHandle {
  readonly clock: Clock;
  readonly store: Store;
  readonly vault: SecretVault;
  /** Which adapter of each port is running (what `daemon.started` recorded). */
  readonly adapters: Composition['adapters'];
  /** Whether the vault is open now (a vault without a master password is always open). */
  readonly vaultLocked: boolean;
  /** The execution of attempts; `undefined` when no clients were given or there is no launcher. */
  readonly execution: Execution | undefined;
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
 * 2. configuration, then `compose` (the only place that names adapters);
 * 3. the lock info is published (pid, start, version) for the "already running" message;
 * 4. state `recovering`: `PRAGMA quick_check` on the store. The daemon refuses to start on a
 *    damaged store and says how to restore (full reconciliation of runs is not built yet);
 * 5. the vault is unlocked with the injected prompt, if it has a master password;
 * 6. `daemon.started` is appended to the log;
 * 7. the execution of attempts is built (when clients were given) and reconciles the attempts the
 *    previous daemon left running: each one is resumed with `session/load`, or parked;
 * 8. the backup scheduler starts (only if the store can make copies);
 * 9. state `running`.
 * Any failure after step 1 releases everything taken so far and rejects.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const paths = dataPaths(options.dataDir);
  const version = options.version ?? packageVersion();
  await ensureDataDir(paths.dataDir);
  const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);

  let composition: Composition | undefined;
  try {
    const config = options.config ?? (await loadConfig(paths.config));
    composition = await compose(config, {
      dataDir: paths.dataDir,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    return await run({ options, config, composition, lock, version });
  } catch (error) {
    await composition?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

interface RunInput {
  readonly options: StartDaemonOptions;
  readonly config: DaemonConfig;
  readonly composition: Composition;
  readonly lock: InstanceLock;
  readonly version: string;
}

async function run(input: RunInput): Promise<DaemonHandle> {
  const { options, config, composition, lock, version } = input;
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

  const execution = buildExecution(options, config, composition, paths.worktrees);
  if (execution !== undefined) {
    const report = await execution.reconcile();
    // The resumed attempts run on; nothing here waits for them.
    void report.done;
  }

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
      await attempt('execution', async () => execution?.stop());
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
    store,
    vault,
    adapters: composition.adapters,
    execution,
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
): Execution | undefined {
  const { logger } = composition;
  if (options.clients === undefined) return undefined;
  const { launcher } = composition;
  if (launcher === undefined) {
    logger.warn('this platform has no process launcher yet; the execution of attempts is off');
    return undefined;
  }
  const clients = options.clients({ launcher, clock: composition.clock });
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
    ...(options.resolveAttempt === undefined ? {} : { resolver: options.resolveAttempt }),
  });
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
