// SPDX-License-Identifier: MPL-2.0
import { homedir, tmpdir } from 'node:os';
import { composeClock, composeStoreFileTools, telemetryPath } from '../../compose.js';
import { readDiscovery } from '../../api/files.js';
import { loadConfig } from '../../config.js';
import { InstanceLock } from '../../instance-lock.js';
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
}

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
      if (pid === undefined) return;
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
    },
    probe: createHealthProbe({ dataDir: journal.dataDir }),
    restoreBackup: async (backupDir) => {
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const config = await loadConfig(paths.config);
        await restoreBackup({
          dataDir: paths.dataDir,
          backupPath: backupDir,
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
