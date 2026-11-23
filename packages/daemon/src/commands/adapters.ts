// SPDX-License-Identifier: MPL-2.0
import { pathFinder, type FindExecutable } from '../clients.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../commands.js';
import { DaemonConfigSchema, loadConfig, type DaemonConfig } from '../config.js';
import {
  AdapterManager,
  isManagedClient,
  MANAGED_CLIENT_IDS,
  MANAGED_CLIENTS,
  type AdapterManagerOptions,
  type ManagedClientId,
} from '../adapters/manager.js';
import type { Env } from '../paths.js';
import { dataPaths } from '../paths.js';

/**
 * `ot adapters status|install [claude-code|codex]` (Phase 10, P13; N254 revised): the managed ACP
 * adapters. `status` says, for each client, which version is pinned, whether it is installed under
 * `<data>/adapters/`, and what the official client and the adapter in `PATH` are. `install` downloads
 * the pinned version from the npm registry (sha512 checked) with no sudo and no change to `PATH`.
 */

export const ADAPTERS_ACTIONS = ['install', 'status'] as const;
export type AdaptersAction = (typeof ADAPTERS_ACTIONS)[number];

export function isAdaptersAction(name: string): name is AdaptersAction {
  return (ADAPTERS_ACTIONS as readonly string[]).includes(name);
}

/** The seams of the manager that a test (or an embedder) may replace. */
export type AdaptersSeam = Pick<
  AdapterManagerOptions,
  'fetch' | 'platform' | 'self' | 'installOptions' | 'lockOf'
>;

export interface AdaptersCommandDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  /** Looks a command up in `PATH`. Default: the file system, over the `PATH` of `env`. */
  readonly find?: FindExecutable | undefined;
  readonly adapters?: AdaptersSeam | undefined;
}

export interface AdaptersOptions {
  readonly json: boolean;
  /** `install`: only these clients (default: both). */
  readonly clients: readonly string[];
}

/** The configuration of the data folder, or the defaults when it cannot be read (the command then says so). */
async function readConfig(dataDir: string): Promise<{ config: DaemonConfig; problem?: string }> {
  try {
    return { config: await loadConfig(dataPaths(dataDir).config) };
  } catch (error) {
    return {
      config: DaemonConfigSchema.parse({}),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The manager of this data folder and configuration; one place for `ot adapters` and `ot init`. */
export function adapterManagerFor(
  dataDir: string,
  config: DaemonConfig,
  deps: Pick<AdaptersCommandDeps, 'platform' | 'env' | 'find' | 'adapters'>,
): AdapterManager {
  return new AdapterManager({
    adaptersDir: dataPaths(dataDir).adapters,
    install: config.clients.adapters.install,
    registry: config.clients.adapters.registry,
    redirectHosts: config.clients.adapters.redirect_hosts,
    redirectMax: config.clients.adapters.redirect_max,
    tarMaxEntries: config.clients.adapters.tar_max_entries,
    find: deps.find ?? pathFinder(deps.env, { platform: deps.platform }),
    ...deps.adapters,
  });
}

/**
 * Installs the adapter of `client` and says how it went. Returns whether it is installed now.
 * Used by `ot adapters install` and by step 3 of `ot init`.
 */
export async function installAndReport(
  context: CommandContext,
  manager: AdapterManager,
  client: ManagedClientId,
  registry: string,
): Promise<boolean> {
  const { t } = context;
  const status = manager.status(client);
  if (status.installed) {
    context.out(
      t('adapters.alreadyInstalled', {
        adapter: status.adapter,
        version: status.version,
        dir: status.dir,
      }),
    );
    return true;
  }
  context.out(
    t('adapters.installing', { adapter: status.adapter, version: status.version, registry }),
  );
  try {
    const result = await manager.ensure(client);
    context.out(
      t('adapters.installed', {
        adapter: status.adapter,
        version: status.version,
        dir: result.dir,
      }),
    );
    return true;
  } catch (error) {
    context.err(
      t('adapters.installFailed', {
        adapter: status.adapter,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

function statusLines(context: CommandContext, manager: AdapterManager, config: DaemonConfig): void {
  const { t } = context;
  context.out(
    t('adapters.mode', {
      install: config.clients.adapters.install,
      registry: config.clients.adapters.registry,
    }),
  );
  for (const client of MANAGED_CLIENT_IDS) {
    const status = manager.status(client);
    const spec = MANAGED_CLIENTS[client];
    context.out(
      t('adapters.statusHead', {
        client,
        adapter: status.adapter,
        version: status.version,
        source: config.clients[client].adapter,
      }),
    );
    context.out(
      status.installed
        ? t('adapters.statusInstalled', { dir: status.dir })
        : t('adapters.statusNotInstalled'),
    );
    context.out(
      status.officialPath === undefined
        ? t('adapters.statusOfficialMissing', { command: spec.official })
        : t('adapters.statusOfficial', { command: spec.official, path: status.officialPath }),
    );
    context.out(
      status.pathAdapter === undefined
        ? t('adapters.statusPathNone', { command: spec.pathCommand })
        : t('adapters.statusPath', { command: spec.pathCommand, path: status.pathAdapter }),
    );
  }
}

export async function runAdaptersCommand(
  context: CommandContext,
  deps: AdaptersCommandDeps,
  action: AdaptersAction,
  options: AdaptersOptions,
): Promise<number> {
  const { t } = context;
  const { config, problem } = await readConfig(context.dataDir);
  if (problem !== undefined) context.err(t('adapters.configProblem', { reason: problem }));
  const manager = adapterManagerFor(context.dataDir, config, deps);

  if (action === 'status') {
    if (options.json) {
      context.out(
        JSON.stringify(
          {
            install: config.clients.adapters.install,
            registry: config.clients.adapters.registry,
            clients: MANAGED_CLIENT_IDS.map((client) => ({
              ...manager.status(client),
              source: config.clients[client].adapter,
            })),
          },
          null,
          2,
        ),
      );
      return EXIT_OK;
    }
    statusLines(context, manager, config);
    return EXIT_OK;
  }

  if (config.clients.adapters.install === 'off') {
    context.err(t('adapters.installOff'));
    return EXIT_FAILED;
  }
  const wanted = options.clients.length === 0 ? [...MANAGED_CLIENT_IDS] : options.clients;
  const clients = wanted.filter(isManagedClient);
  let failed = 0;
  for (const client of clients) {
    if (!(await installAndReport(context, manager, client, config.clients.adapters.registry))) {
      failed += 1;
    }
    if (manager.status(client).officialPath === undefined) {
      context.out(t('adapters.noOfficial', { command: MANAGED_CLIENTS[client].official }));
    }
  }
  if (failed > 0) return EXIT_FAILED;
  context.out(t('adapters.restartHint'));
  return EXIT_OK;
}
