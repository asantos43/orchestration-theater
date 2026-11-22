// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { readDiscovery } from '../api/files.js';
import type { TuiStartDaemonMode } from '../config.js';
import type { Env } from '../paths.js';
import { ServiceError, type ServiceCommand, type ServiceManager } from './types.js';

/** Starts the daemon as a child of the user's own, detached from this terminal. */
export type DaemonSpawn = (
  command: ServiceCommand,
  env: Env,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;

/** The real {@link DaemonSpawn}: detached, no window, no stdio, so it outlives the interface that started it. */
export const spawnDetachedDaemon: DaemonSpawn = (command, env) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command.command, [...command.args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...env },
      });
      child.once('error', (error) => {
        resolve({ ok: false, detail: error.message });
      });
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });

export interface EnsureDaemonInput {
  readonly dataDir: string;
  /** Where the daemon publishes `api.json` (`dataPaths(dataDir).apiDiscovery`). */
  readonly discoveryFile: string;
  readonly mode: TuiStartDaemonMode;
  readonly timeoutMs: number;
  /** What the service or the child runs, with `daemon --data-dir` already in; `undefined` when `ot` cannot say. */
  readonly daemonCommand: ServiceCommand | undefined;
  readonly service: ServiceManager | undefined;
  readonly spawnDaemon: DaemonSpawn;
  readonly env: Env;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly alive?: ((pid: number) => boolean) | undefined;
}

export type EnsureDaemonOutcome =
  /** A daemon was already running: nothing was started. */
  | { readonly kind: 'running' }
  /** `tui.start_daemon: off`, and no daemon: nothing was started. */
  | { readonly kind: 'off' }
  /**
   * A daemon was started and published its API. `fallback` is why the child was started in the
   * place of the service (`service` mode only): the detail is what the manager printed.
   */
  | {
      readonly kind: 'started';
      readonly via: 'service' | 'child';
      readonly fallback?: {
        readonly reason: 'not_installed' | 'service_failed';
        readonly detail: string;
      };
    }
  | {
      readonly kind: 'failed';
      readonly reason: 'no_command' | 'spawn_failed' | 'timeout';
      readonly detail: string;
    };

const POLL_MS = 100;

/**
 * What `ot tui` does before the interface opens (Phase 10, P3; `tui.start_daemon`). The test of
 * "is it running" is `api.json` with a live pid, the same one the clients use. `service` mode
 * starts the logon service when it is installed, and a detached child when it is not (or when it
 * cannot start); `child` always starts the child; `off` starts nothing. Never throws: a daemon
 * that does not come up is an outcome, and the interface opens anyway and says there is no daemon.
 */
export async function ensureDaemon(input: EnsureDaemonInput): Promise<EnsureDaemonOutcome> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = input.now ?? Date.now;
  const isLive = async (): Promise<boolean> =>
    (await readDiscovery(input.discoveryFile, input.alive)).kind === 'live';

  if (await isLive()) return { kind: 'running' };
  if (input.mode === 'off') return { kind: 'off' };

  let via: 'service' | 'child' = 'child';
  let fallback: { reason: 'not_installed' | 'service_failed'; detail: string } | undefined;
  if (input.mode === 'service' && input.service !== undefined) {
    try {
      await input.service.start();
      via = 'service';
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'not_installed') {
        fallback = { reason: 'not_installed', detail: error.message };
      } else {
        fallback = {
          reason: 'service_failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } else if (input.mode === 'service') {
    fallback = { reason: 'not_installed', detail: 'no service manager on this platform' };
  }

  if (via === 'child') {
    if (input.daemonCommand === undefined) {
      return { kind: 'failed', reason: 'no_command', detail: 'the entry of ot is not known' };
    }
    const spawned = await input.spawnDaemon(input.daemonCommand, input.env);
    if (!spawned.ok) return { kind: 'failed', reason: 'spawn_failed', detail: spawned.detail };
  }

  const deadline = now() + input.timeoutMs;
  for (;;) {
    if (await isLive()) {
      return { kind: 'started', via, ...(fallback === undefined ? {} : { fallback }) };
    }
    if (now() >= deadline) {
      return { kind: 'failed', reason: 'timeout', detail: `${String(input.timeoutMs)} ms` };
    }
    await sleep(POLL_MS);
  }
}
