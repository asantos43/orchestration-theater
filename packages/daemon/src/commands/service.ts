// SPDX-License-Identifier: MPL-2.0
import { rm, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { hasErrorCode } from '@otheater/core';
import { readDiscovery } from '../api/files.js';
import type { FindExecutable } from '../clients.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../commands.js';
import { DaemonConfigSchema, loadConfig, type DaemonConfig } from '../config.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths } from '../paths.js';
import { ensureDaemon, type DaemonSpawn } from '../service/ensure-daemon.js';
import { daemonCommandOf } from '../service/self-command.js';
import {
  ServiceError,
  type ServiceCommand,
  type ServiceManager,
  type ServiceSpec,
} from '../service/types.js';
import type { Env } from '../paths.js';

export const SERVICE_ACTIONS = ['install', 'uninstall', 'status', 'start', 'stop'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export function isServiceAction(name: string): name is ServiceAction {
  return (SERVICE_ACTIONS as readonly string[]).includes(name);
}

export interface ServiceCommandDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  /** The manager of this platform; `undefined` where there is none. */
  readonly service: ServiceManager | undefined;
  /** What the service runs (see `resolveServiceCommand`); `undefined` when `ot` cannot say. */
  readonly self: ServiceCommand | undefined;
  /** Asks a yes or no in the terminal; none without a terminal. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly homedir?: string | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly alive?: ((pid: number) => boolean) | undefined;
}

export interface ServiceOptions {
  /** `install`: do not start the daemon now. */
  readonly noStart: boolean;
  readonly json: boolean;
}

/** How long `stop` waits for the daemon to go away (a clean stop closes the store and the sessions). */
const STOP_WAIT_MS = 15_000;
const POLL_MS = 100;

/** Windows has no `PATH` of the service of its own; the others get the one of the shell that installs. */
function userIdOf(platform: NodeJS.Platform, env: Env): string | undefined {
  if (platform !== 'win32') return undefined;
  const user = env.USERNAME;
  if (user === undefined || user === '') return undefined;
  const domain = env.USERDOMAIN;
  return domain === undefined || domain === '' ? user : `${domain}\\${user}`;
}

function describeFailure(error: unknown): string {
  if (error instanceof ServiceError) {
    return error.detail === '' ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `ot service install | uninstall | status | start | stop` (Phase 10, P3). It runs without the
 * daemon and emits no event: the registry of the service is the system's, not the store's.
 * `uninstall` removes only the definition; the data folder is never touched here.
 */
export async function runServiceCommand(
  context: CommandContext,
  deps: ServiceCommandDeps,
  action: ServiceAction,
  options: ServiceOptions,
): Promise<number> {
  const { t } = context;
  if (deps.service === undefined) {
    context.err(t('service.unsupported', { platform: deps.platform }));
    return EXIT_FAILED;
  }
  const service = deps.service;
  const discoveryFile = dataPaths(context.dataDir).apiDiscovery;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const isLive = async (): Promise<boolean> =>
    (await readDiscovery(discoveryFile, deps.alive)).kind === 'live';

  try {
    switch (action) {
      case 'install': {
        if (deps.self === undefined) {
          context.err(t('service.noEntry'));
          return EXIT_FAILED;
        }
        const config = await loadConfig(dataPaths(context.dataDir).config);
        const spec: ServiceSpec = {
          id: service.id,
          command: daemonCommandOf(deps.self, context.dataDir),
          dataDir: context.dataDir,
          restart: config.service.restart,
          autostart: config.service.autostart,
          console: config.service.console,
          userId: userIdOf(deps.platform, deps.env),
          path: deps.platform === 'win32' ? undefined : deps.env.PATH,
        };
        const result = await service.install(spec);
        context.out(t('service.installed', { location: result.location }));
        for (const note of result.notes) context.out(t(`service.note_${note}`));
        context.out(
          t(spec.autostart === 'logon' ? 'service.autostartLogon' : 'service.autostartManual'),
        );
        if (deps.platform === 'linux') context.out(t('service.lingerNote'));
        if (spec.autostart === 'logon' && !options.noStart) {
          if (await isLive()) {
            context.out(t('service.alreadyRunning'));
          } else {
            try {
              await service.start();
              context.out(t('service.started'));
            } catch (error) {
              // Installed is installed: a daemon that cannot start now is a warning, not a failure.
              context.err(t('service.startFailed', { detail: describeFailure(error) }));
            }
          }
        }
        return EXIT_OK;
      }
      case 'uninstall': {
        const before = await service.status();
        try {
          await stopAndWait(service, before.installed, isLive, sleep, now);
        } catch {
          // A stop that fails must not keep the definition in place: uninstall tries it again.
        }
        await service.uninstall();
        context.out(t(before.installed ? 'service.uninstalled' : 'service.wasNotInstalled'));
        return EXIT_OK;
      }
      case 'status': {
        const status = await service.status();
        const reading = await readDiscovery(discoveryFile, deps.alive);
        const daemon =
          reading.kind === 'live'
            ? { running: true, pid: reading.info.pid, url: reading.info.url }
            : { running: false };
        if (options.json) {
          context.out(JSON.stringify({ service: { kind: service.kind, ...status }, daemon }));
          return EXIT_OK;
        }
        if (!status.installed) {
          context.out(t('service.statusNotInstalled', { location: status.location }));
        } else {
          context.out(t('service.statusInstalled', { location: status.location }));
          if (status.note === 'no_session') context.out(t('service.noSession'));
          else {
            context.out(t('service.statusEnabled', { value: yesNo(t, status.enabled) }));
            context.out(t('service.statusActive', { value: yesNo(t, status.active) }));
          }
        }
        context.out(
          daemon.running
            ? t('service.statusDaemonRunning', { pid: daemon.pid, url: daemon.url })
            : t('service.statusDaemonStopped'),
        );
        if (deps.platform === 'linux' && status.installed) context.out(t('service.lingerNote'));
        return EXIT_OK;
      }
      case 'start': {
        if (await isLive()) {
          context.out(t('service.alreadyRunning'));
          return EXIT_OK;
        }
        await service.start();
        context.out(t('service.startedNow'));
        return EXIT_OK;
      }
      case 'stop': {
        await stopAndWait(service, true, isLive, sleep, now);
        context.out(t('service.stopped'));
        return EXIT_OK;
      }
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'not_installed') {
      context.err(t('service.notInstalled'));
    } else if (error instanceof ServiceError && error.code === 'unavailable') {
      context.err(t('service.unavailable', { detail: describeFailure(error) }));
    } else {
      context.err(t('service.failed', { detail: describeFailure(error) }));
    }
    return EXIT_FAILED;
  }
}

function yesNo(t: CommandContext['t'], value: boolean | undefined): string {
  if (value === undefined) return t('service.unknown');
  return t(value ? 'service.yes' : 'service.no');
}

/**
 * Stops the daemon through the service and waits until `api.json` says it is gone. [proposta] There
 * is no API route that stops the daemon, so the clean stop is the signal the manager sends
 * (SIGTERM on Linux and macOS; the Task Scheduler ends the process on Windows). A service that is
 * not installed, or one that has nothing running, is not an error here.
 */
async function stopAndWait(
  service: ServiceManager,
  installed: boolean,
  isLive: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  if (!installed) return;
  await service.stop();
  const deadline = now() + STOP_WAIT_MS;
  while ((await isLive()) && now() < deadline) await sleep(POLL_MS);
}

export interface UninstallOptions {
  /** [proposta] Also delete the whole data folder. Never the default. */
  readonly purgeData: boolean;
  readonly yes: boolean;
}

/** Why a data folder is not deleted (a message key of `uninstall.refused_*`). */
export type PurgeRefusal = 'root' | 'home' | 'not_data';

/**
 * Whether `dir` may be deleted as the data folder. [proposta] Refuses the root of a drive, the
 * home folder (and any folder above it), and a folder that does not look like an OTheater data
 * folder (none of `config.yaml`, `store.sqlite`, `daemon-id`): a wrong `--data-dir` must not become
 * a deletion of something else.
 */
export async function purgeRefusalOf(dir: string, home: string): Promise<PurgeRefusal | undefined> {
  const target = resolve(dir);
  if (target === parse(target).root) return 'root';
  const fromTarget = relative(target, resolve(home));
  // The home folder is the target, or lies inside it (the target is above the home).
  if (fromTarget === '' || (!fromTarget.startsWith('..') && !isAbsolute(fromTarget))) return 'home';
  const paths = dataPaths(target);
  for (const marker of [paths.config, paths.store, paths.daemonId]) {
    try {
      await stat(marker);
      return undefined;
    } catch {
      // Try the next marker.
    }
  }
  return 'not_data';
}

/**
 * `ot uninstall [--purge-data] [--yes]` (Phase 10, P3). Removes the logon service and keeps the
 * data. With `--purge-data` it also deletes the data folder, after a question (or `--yes`), and
 * never while a daemon holds the instance lock. The keyring entries are not touched.
 */
export async function runUninstallCommand(
  context: CommandContext,
  deps: ServiceCommandDeps,
  options: UninstallOptions,
): Promise<number> {
  const { t } = context;
  const dir = resolve(context.dataDir);
  const home = deps.homedir ?? osHomedir();

  if (options.purgeData) {
    const refusal = await purgeRefusalOf(dir, home);
    if (refusal !== undefined) {
      context.err(t(`uninstall.refused_${refusal}`, { dir }));
      return EXIT_FAILED;
    }
    if (!options.yes) {
      if (deps.confirm === undefined) {
        context.err(t('uninstall.needYes'));
        return EXIT_FAILED;
      }
      if (!(await deps.confirm(t('uninstall.confirmPurge', { dir })))) {
        context.out(t('uninstall.cancelled'));
        return EXIT_FAILED;
      }
    }
  }

  // The service first: it also stops the daemon, which the deletion needs.
  const code = await runServiceCommand(context, deps, 'uninstall', { noStart: false, json: false });
  if (code !== EXIT_OK) return code;
  if (!options.purgeData) {
    context.out(t('uninstall.keptData', { dir }));
    return EXIT_OK;
  }

  const paths = dataPaths(dir);
  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (!hasErrorCode(error, 'CONFLICT')) throw error;
    context.err(t('uninstall.refused_running', { dir }));
    return EXIT_FAILED;
  }
  await lock.release();
  // `force` makes a folder that is already gone a success; the parent is never touched.
  await rm(dir, { recursive: true, force: true });
  context.out(t('uninstall.purged', { dir }));
  return EXIT_OK;
}

/**
 * What `main` is given to work with services: the manager of the platform, and how to start a
 * daemon child. The entry point builds the real ones; a test gives fakes; without it `ot service`
 * says there is none and `ot tui` starts nothing (so no test reaches the real manager by accident).
 */
export interface ServiceHost {
  readonly manager: ServiceManager | undefined;
  readonly spawnDaemon: DaemonSpawn;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly alive?: ((pid: number) => boolean) | undefined;
  /** `ot init`: how a command is looked up in `PATH` (default: the file system; a test says what is installed). */
  readonly find?: FindExecutable | undefined;
}

/**
 * Before the terminal interface opens: starts the daemon if it is not running (`tui.start_daemon`).
 * A daemon that does not come up is a warning on stderr, never a failure: the interface opens
 * anyway and says there is no daemon, as it did before this step.
 */
export async function startDaemonForTui(
  context: Pick<CommandContext, 'dataDir' | 't' | 'err'>,
  deps: ServiceCommandDeps & { readonly spawnDaemon: DaemonSpawn },
  config: DaemonConfig['tui'] | undefined,
): Promise<void> {
  const tui = config ?? DaemonConfigSchema.parse({}).tui;
  const { t } = context;
  const outcome = await ensureDaemon({
    dataDir: context.dataDir,
    discoveryFile: dataPaths(context.dataDir).apiDiscovery,
    mode: tui.start_daemon,
    timeoutMs: tui.start_timeout,
    daemonCommand:
      deps.self === undefined ? undefined : daemonCommandOf(deps.self, context.dataDir),
    service: deps.service,
    spawnDaemon: deps.spawnDaemon,
    env: deps.env,
    sleep: deps.sleep,
    now: deps.now,
    alive: deps.alive,
  });
  if (outcome.kind === 'failed') {
    context.err(t(`tui.startFailed_${outcome.reason}`, { detail: outcome.detail }));
  } else if (outcome.kind === 'started' && outcome.fallback?.reason === 'service_failed') {
    context.err(t('tui.serviceFallback', { detail: outcome.fallback.detail }));
  }
}
