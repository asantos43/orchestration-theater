// SPDX-License-Identifier: MPL-2.0
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { composeClock, composeStoreFileTools, telemetryPath } from '../../compose.js';
import { readDiscovery } from '../../api/files.js';
import { loadConfig } from '../../config.js';
import { InstanceLock, readLockInfo } from '../../instance-lock.js';
import { type Logger } from '../../logger.js';
import { dataPaths } from '../../paths.js';
import { restoreBackup } from '../../recovery/restore.js';
import {
  createServiceManager,
  daemonCommandOf,
  execRunner,
  type ServiceManager,
} from '../../service/index.js';
import { ensureDaemon, spawnDetachedDaemon } from '../../service/ensure-daemon.js';
import { sha256OfFile } from '../verify.js';
import type { ApplyPorts } from './applier.js';
import { createHealthProbe } from './health.js';
import type { UpdateJournal } from './journal.js';
import type { InstallLayout } from './layout.js';

/** Whether a process exists (a process that is not ours counts as existing). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const REAL_SLEEP = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface RealPortsInput {
  readonly layout: InstallLayout;
  readonly journal: UpdateJournal;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The service of this platform; the default is the real one. */
  readonly service?: ServiceManager | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * How long the rollback looks for a daemon that holds the instance lock without having published
   * `api.json` (a migration that outlasts the health timeout). Default {@link LOCK_HOLDER_WAIT_MS}.
   * [proposta] key `updates.apply.lock_holder_wait_ms`.
   */
  readonly lockHolderWaitMs?: number | undefined;
}

/** The default of `lockHolderWaitMs`. */
export const LOCK_HOLDER_WAIT_MS = 10_000;

/**
 * The effects of the applier as they are on a real machine (Phase 10, P8): the clock, the daemon
 * started the way `ot tui` starts it (the logon service when it is installed, a detached child
 * when not), the health probe over `api.json`, and the restore of a backup under the instance lock.
 * The tests of the swap give fakes for the daemon and run the rest for real.
 */
export function realApplyPorts(input: RealPortsInput): ApplyPorts {
  const { layout, journal } = input;
  const env = input.env ?? process.env;
  const paths = dataPaths(journal.dataDir);
  const service =
    input.service ??
    createServiceManager({
      platform: process.platform,
      env,
      homedir: homedir(),
      uid: process.getuid?.(),
      run: execRunner,
      tmpDir: tmpdir(),
    });

  const livePid = async (): Promise<number | undefined> => {
    const reading = await readDiscovery(paths.apiDiscovery);
    return reading.kind === 'live' ? reading.info.pid : undefined;
  };
  const waitGone = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (processAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await REAL_SLEEP(200);
    }
    return true;
  };

  const endProcess = async (pid: number): Promise<void> => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    if (await waitGone(pid, 15_000)) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It ended in between.
    }
    await waitGone(pid, 5000);
  };
  const endLockHolder = async (): Promise<void> => {
    const deadline = Date.now() + (input.lockHolderWaitMs ?? LOCK_HOLDER_WAIT_MS);
    let ended = 0;
    for (;;) {
      try {
        const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
        await lock.release();
        return;
      } catch {
        // Held: by whom?
      }
      const holder = await readLockInfo(paths.lockInfo);
      if (
        ended < 3 &&
        holder !== undefined &&
        holder.pid !== process.pid &&
        processAlive(holder.pid)
      ) {
        ended += 1;
        await endProcess(holder.pid);
        continue;
      }
      if (Date.now() >= deadline) {
        input.logger.warn(
          { lock: paths.lock },
          'update: the instance lock is still held; the backup may not be restored',
        );
        return;
      }
      await REAL_SLEEP(200);
    }
  };

  return {
    clock: { now: () => Date.now(), sleep: (ms) => REAL_SLEEP(ms) },
    isAlive: processAlive,
    startDaemon: async () => {
      const outcome = await ensureDaemon({
        dataDir: journal.dataDir,
        discoveryFile: paths.apiDiscovery,
        mode: 'service',
        timeoutMs: journal.healthTimeoutMs,
        daemonCommand: daemonCommandOf({ command: layout.exe, args: [] }, journal.dataDir),
        service,
        spawnDaemon: spawnDetachedDaemon,
        env,
      });
      input.logger.info({ outcome }, 'update: the new daemon was asked to start');
      if (outcome.kind === 'running' || outcome.kind === 'started') return { ok: true };
      return { ok: false, detail: outcome.kind === 'failed' ? outcome.detail : outcome.kind };
    },
    stopDaemon: async () => {
      // The service first, so that a manager that restarts what dies does not bring it back.
      try {
        await service?.stop();
      } catch {
        // Not installed, or not running through it: the pid below is the fallback.
      }
      const pid = await livePid();
      if (pid !== undefined) await endProcess(pid);
      // A daemon that took the lock and has not published `api.json` yet is not found by the
      // discovery file, and the restore of the backup needs the lock (Phase 11, P6).
      await endLockHolder();
    },
    probe: createHealthProbe({ dataDir: journal.dataDir }),
    // `updates.apply.fs_retry` and `fs_retry_timeout`, as the daemon wrote them in the journal; a
    // journal from before the keys has neither, and `retryFs` then uses `auto` and 15 s.
    fsRetry: { mode: journal.fsRetry, timeoutMs: journal.fsRetryTimeoutMs },
    restoreBackup: async (backupDir) => {
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const config = await loadConfig(paths.config);
        // The journal names the backup, and a journal is a file a user can write (P8a): only a folder
        // inside the backup folder of the configuration is restored, as `ot restore` would find it.
        const root = resolve(paths.dataDir, config.backup.dir);
        const relation = relative(root, resolve(backupDir));
        if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
          throw new Error('the backup of the journal is not inside the backup folder');
        }
        await restoreBackup({
          dataDir: paths.dataDir,
          backupPath: resolve(backupDir),
          tools: composeStoreFileTools(config, paths.dataDir),
          clock: composeClock(undefined),
          telemetryFile: telemetryPath(config, paths.dataDir),
        });
      } finally {
        await lock.release();
      }
    },
    sha256: sha256OfFile,
    logger: input.logger,
  };
}
