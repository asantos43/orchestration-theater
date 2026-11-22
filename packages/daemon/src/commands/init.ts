// SPDX-License-Identifier: MPL-2.0
import { readDiscovery } from '../api/files.js';
import { pathFinder, type FindExecutable } from '../clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, VERSION_PACKAGES } from '../compose.js';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../commands.js';
import { DaemonConfigSchema, loadConfig, type ClientId, type DaemonConfig } from '../config.js';
import { dataPaths, resolveDataDir } from '../paths.js';
import { ensureDaemon, type DaemonSpawn } from '../service/ensure-daemon.js';
import { daemonCommandOf } from '../service/self-command.js';
import { runServiceCommand, type ServiceCommandDeps } from './service.js';

/**
 * `ot init` (Phase 10, P6; architecture 5.7 and 10; N121, N254). The minimum command, with no
 * question in the terminal: (1) the logon service, (2) the daemon up and its API answering, (3) a
 * look at the commands of the Executors, (4) the terminal interface, which opens its setup assistant
 * by itself when no configuration exists (`ui.setup.open`).
 *
 * A step that fails ends the command with the reason and the command that repeats that step; what
 * was done before stays (nothing is undone). Step 3 never installs anything (N254): it shows what
 * is missing and the `npm` command for the user to run.
 */

export interface InitDeps extends ServiceCommandDeps {
  /** How a daemon child is started when the service cannot start it (`ensureDaemon`). */
  readonly spawnDaemon: DaemonSpawn;
  /** Looks a command up in `PATH`. Default: the file system, over the `PATH` of `env`. Tests say what is installed. */
  readonly find?: FindExecutable | undefined;
  /**
   * Opens the terminal interface and gives its exit code; `undefined` where there is no terminal
   * (the command then says so and ends, the steps 1 to 3 done).
   */
  readonly openTui?: ((ui: DaemonConfig['ui']) => Promise<number>) | undefined;
}

export interface InitOptions {
  /** [proposta] Steps 1 to 3 only, then exit: for the installers and the tests. */
  readonly noTui: boolean;
}

/** One command step 3 looks for. `adapter` is the ACP program; `client` is the client's own CLI. */
interface CommandCheck {
  readonly id: ClientId;
  readonly kind: 'adapter' | 'client';
  readonly executable: string;
  /** The npm package that holds it, for the command the user runs. */
  readonly pkg: string;
}

/**
 * [V: all five package names exist in the npm registry, checked on 2026-11-22; the ACP adapters
 * and `opencode-ai` are the ones the adapters of the daemon name.]
 */
const CLIENT_CLI_PACKAGES: Readonly<Record<'claude-code' | 'codex', { cmd: string; pkg: string }>> =
  {
    'claude-code': { cmd: 'claude', pkg: '@anthropic-ai/claude-code' },
    codex: { cmd: 'codex', pkg: '@openai/codex' },
  };

/** What step 3 looks for in `PATH`, with `clients.<id>.command` and `clients.<id>.enabled` applied. */
export function commandChecks(config: Pick<DaemonConfig, 'clients'>): {
  readonly checks: readonly CommandCheck[];
  readonly off: readonly ClientId[];
} {
  const checks: CommandCheck[] = [];
  const off: ClientId[] = [];
  for (const id of ['claude-code', 'codex', 'opencode'] as const) {
    const section = config.clients[id];
    if (section.enabled === false) {
      off.push(id);
      continue;
    }
    const executable = section.command?.cmd ?? DEFAULT_CLIENT_EXECUTABLES[id];
    const pkg = VERSION_PACKAGES[id][0];
    if (pkg === undefined) continue;
    // OpenCode is its own ACP program (`opencode acp`): one command, no separate adapter.
    checks.push({ id, kind: id === 'opencode' ? 'client' : 'adapter', executable, pkg });
    if (id !== 'opencode') {
      const own = CLIENT_CLI_PACKAGES[id];
      checks.push({ id, kind: 'client', executable: own.cmd, pkg: own.pkg });
    }
  }
  return { checks, off };
}

/** `ot <args>` as the user types it again: `--data-dir` only when it is not the default folder. */
function repeatCommand(context: CommandContext, deps: InitDeps, args: string): string {
  const fallback = resolveDataDir({
    flag: undefined,
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir ?? '',
  });
  if (context.dataDir === fallback) return `ot ${args}`;
  const dir = /\s/.test(context.dataDir) ? `"${context.dataDir}"` : context.dataDir;
  return `ot ${args} --data-dir ${dir}`;
}

async function readConfigOrDefaults(dataDir: string): Promise<DaemonConfig> {
  try {
    return await loadConfig(dataPaths(dataDir).config);
  } catch {
    // The install step already stopped on a broken file; here the defaults are enough to look.
    return DaemonConfigSchema.parse({});
  }
}

export async function runInitCommand(
  context: CommandContext,
  deps: InitDeps,
  options: InitOptions,
): Promise<number> {
  const { t } = context;
  const total = options.noTui ? 3 : 4;
  const failed = (step: number, reason: string, repeat: string): number => {
    context.err(t('init.failed', { step, reason }));
    context.err(t('init.repeat', { command: repeatCommand(context, deps, repeat) }));
    return EXIT_FAILED;
  };

  // 1. The service. Already installed is a success: the definition is not written again.
  context.out(t('init.stepService', { step: 1, total }));
  if (deps.service === undefined) {
    return failed(1, t('service.unsupported', { platform: deps.platform }), 'service install');
  }
  try {
    const status = await deps.service.status();
    if (status.installed) {
      context.out(t('init.serviceAlready', { location: status.location }));
    } else {
      const problems: string[] = [];
      const quiet: CommandContext = { ...context, err: (line) => problems.push(line) };
      const code = await runServiceCommand(quiet, deps, 'install', { noStart: true, json: false });
      if (code !== EXIT_OK) {
        return failed(1, problems.join(' '), 'service install');
      }
    }
  } catch (error) {
    return failed(1, error instanceof Error ? error.message : String(error), 'service install');
  }

  // 2. The daemon, and the wait for its API.
  context.out(t('init.stepDaemon', { step: 2, total }));
  const config = await readConfigOrDefaults(context.dataDir);
  const discoveryFile = dataPaths(context.dataDir).apiDiscovery;
  const outcome = await ensureDaemon({
    dataDir: context.dataDir,
    discoveryFile,
    // [proposta] `tui.start_daemon: off` means "the interface starts nothing", not "init does not":
    // here the service is what starts it.
    mode: config.tui.start_daemon === 'off' ? 'service' : config.tui.start_daemon,
    timeoutMs: config.tui.start_timeout,
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
    return failed(
      2,
      t(`init.daemonFailed_${outcome.reason}`, { detail: outcome.detail }),
      'service start',
    );
  }
  if (outcome.kind === 'off') {
    // Not reachable with the mode above; kept so a new mode cannot slip through unsaid.
    return failed(2, t('init.daemonFailed_off'), 'service start');
  }
  const reading = await readDiscovery(discoveryFile, deps.alive);
  const url = reading.kind === 'live' ? reading.info.url : '?';
  if (outcome.kind === 'running') {
    context.out(t('init.daemonRunning', { url }));
  } else {
    context.out(t(`init.daemonStarted_${outcome.via}`, { url }));
    if (outcome.fallback?.reason === 'service_failed') {
      context.err(t('tui.serviceFallback', { detail: outcome.fallback.detail }));
    }
  }

  // 3. The commands of the Executors: only shown, never installed (N254).
  context.out(t('init.stepClients', { step: 3, total }));
  const find = deps.find ?? pathFinder(deps.env, { platform: deps.platform });
  const { checks, off } = commandChecks(config);
  let missing = 0;
  for (const check of checks) {
    const name = t(`init.name_${check.kind}`, { id: check.id, command: check.executable });
    const found = find(check.executable);
    if (found !== undefined) {
      context.out(t('init.commandFound', { name, path: found }));
      continue;
    }
    missing += 1;
    context.out(t('init.commandMissing', { name, command: `npm install -g ${check.pkg}` }));
  }
  for (const id of off) context.out(t('init.clientOff', { id }));
  context.out(t(missing === 0 ? 'init.allFound' : 'init.someMissing', { count: missing }));

  // 4. The interface, which opens the assistant of the first run by itself.
  if (options.noTui) {
    context.out(t('init.doneNoTui'));
    return EXIT_OK;
  }
  if (deps.openTui === undefined) {
    context.out(t('init.noTerminal'));
    return EXIT_OK;
  }
  context.out(t('init.stepTui', { step: 4, total }));
  if (config.ui.setup.open === 'never') context.out(t('init.setupNever'));
  return await deps.openTui(config.ui);
}
