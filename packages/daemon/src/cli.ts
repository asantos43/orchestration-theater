#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Secret } from '@otheater/core';
import type { TFunction } from 'i18next';
import { runApiRotateTokenCommand } from './commands-api.js';
import { runChatCommand } from './chat-command.js';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runBackupCommand,
  runRestoreCommand,
  type CommandContext,
} from './commands.js';
import type { ComposeOverrides } from './compose.js';
import { isSeaProcess } from '@otheater/client/node';
import type { ClientFactory } from './clients.js';
import { loadConfig } from './config.js';
import {
  isDirectiveAction,
  runDirectivesCommand,
  type DirectivesOptions,
} from './directives/command.js';
import { startDaemon, type PasswordPrompt } from './daemon.js';
import { isPluginAction, runPluginCommand } from './plugins/command.js';
import { isExecutorAction, runExecutorCommand, type ExecutorOptions } from './executors/command.js';
import type { TestSession } from './executors/test-session.js';
import {
  createTranslator,
  detectSystemLocale,
  resolveLocale,
  type Locale,
  type LocaleSetting,
} from './i18n.js';
import { dataPaths, resolveDataDir, type Env } from './paths.js';
import { isProfileAction, runProfileCommand, type ProfileOptions } from './profiles/command.js';
import { runProfileExec, type ExecSignals, type ExecSpawn } from './profiles/exec.js';
import { runProfileShims, type ShimsOptions } from './profiles/shims-command.js';
import type { OtLauncher } from './profiles/shims.js';
import { resolveSelfCommand } from './sea/self-command.js';
import {
  isTrajectoryAction,
  runTrajectoryCommand,
  type TrajectoryOptions,
} from './atif/command.js';
import { runAnalysisCommand, type AnalysisOptions } from './analysis/command.js';
import {
  isServiceAction,
  runServiceCommand,
  runUninstallCommand,
  startDaemonForTui,
  type ServiceCommandDeps,
  type ServiceHost,
} from './commands/service.js';
import { spawnDetachedDaemon, type DaemonSpawn } from './service/ensure-daemon.js';
import { isAdaptersAction, runAdaptersCommand, type AdaptersSeam } from './commands/adapters.js';
import { isManagedClient } from './adapters/manager.js';
import { runInitCommand } from './commands/init.js';
import { execRunner } from './service/command-runner.js';
import { createServiceManager } from './service/index.js';
import { resolveServiceCommand } from './service/self-command.js';
import { recoverAtStart } from './updates/apply/recover.js';
import { packageVersion } from './version.js';

/** Everything `main` takes from the outside, so a test can run the CLI without a process. */
export interface CliDeps {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Aborting stops a running `ot daemon` (the entry point wires SIGINT and SIGTERM to it). */
  readonly signal?: AbortSignal | undefined;
  /** Builds the password prompt, given the translator; `undefined` when there is no terminal. */
  readonly passwordPrompt?: ((t: TFunction) => PasswordPrompt) | undefined;
  readonly overrides?: ComposeOverrides | undefined;
  /** Replaces `Intl`/`LANG` detection in tests. */
  readonly systemLocale?: string | undefined;
  readonly version?: string | undefined;
  /** The folder `ot chat` works on when `--repo` is not given. */
  readonly cwd?: string | undefined;
  /** What the Producer types in `ot chat`, one message per line. */
  readonly input?: NodeJS.ReadableStream | undefined;
  /** Builds the client adapters of `ot profile` (default: the real clients found in `PATH`). */
  readonly clients?: ClientFactory | undefined;
  /** The short test session of `ot executor add` (none in the terminal: tests give a fake). */
  readonly executorTestSession?: TestSession | undefined;
  /** Starts the CLI of `ot profile exec` (default: the real one, in this terminal). */
  readonly execSpawn?: ExecSpawn | undefined;
  /** The signals while `ot profile exec` runs (default: the process's). */
  readonly execSignals?: ExecSignals | undefined;
  /**
   * What the commands by profile call (P28b): Node and the entry of `ot`, both absolute. Without
   * it, `ot profile shims sync` refuses and `add`/`remove` write no script.
   */
  readonly otLauncher?: OtLauncher | undefined;
  /** Asks a yes or no in the terminal (`ot profile shims path --install`); none without a terminal. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** Asks a line in the terminal without echo (`ot plugin secret set`); none without a terminal. */
  readonly askHidden?: ((question: string) => Promise<string | undefined>) | undefined;
  /** True when the input and the output are a terminal (`ot tui`, and `ot` with no command). */
  readonly interactive?: boolean | undefined;
  /**
   * Runs the terminal interface and gives its exit code (default: the launcher of `@otheater/tui`,
   * loaded only when it is needed, which starts the interface in a process of its own).
   */
  readonly launchTui?: TuiRunner | undefined;
  /**
   * The logon service and the daemon child (Phase 10, P3): the manager of the platform and how to
   * start a detached daemon. Without it `ot service` has no manager and `ot tui` starts no daemon.
   */
  readonly serviceHost?: ServiceHost | undefined;
  /** The seams of the managed ACP adapters (P13): the download, the platform, how the program runs itself. Tests only. */
  readonly adapters?: AdaptersSeam | undefined;
}

/** What `ot tui` hands to the launcher: the data folder and the `ui` part of the configuration. */
export interface TuiRun {
  readonly dataDir: string;
  readonly ui: unknown;
  readonly env: Env;
}

export type TuiRunner = (run: TuiRun) => Promise<number>;

/**
 * The default {@link TuiRunner}. The import is dynamic: `ot daemon`, `ot backup` and the others
 * never load the package, and the package never imports the daemon (no cycle).
 */
const launchBuiltTui: TuiRunner = async (run) => {
  const { launchTui } = await import('@otheater/tui/launcher');
  return await launchTui({ dataDir: run.dataDir, ui: run.ui, env: run.env });
};

/** The daemon child of `ot init` when the entry point gave no service host: none is started. */
const noSpawn: DaemonSpawn = () =>
  Promise.resolve({ ok: false, detail: 'no way to start a daemon here' });

/** Period of the timer that keeps `ot daemon` alive (any value below 2^31 ms; it only has to exist). */
const KEEP_ALIVE_MS = 1_000_000_000;

const COMMANDS = [
  'daemon',
  'backup',
  'restore',
  'directives',
  'chat',
  'profile',
  'executor',
  'api',
  'trajectory',
  'analysis',
  'tui',
  'plugin',
  'service',
  'uninstall',
  'init',
  'adapters',
] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/**
 * Locale for what `ot` prints: `ui.locale` from `<data>/config.yaml` when it can be read, else the
 * system's. A broken config must not stop `ot --help`, so a failure here falls back to `auto`.
 */
async function localeFor(dataDir: string, deps: CliDeps): Promise<Locale> {
  let setting: LocaleSetting = 'auto';
  try {
    setting = (await loadConfig(dataPaths(dataDir).config)).ui.locale;
  } catch {
    // Reported by the command itself if it needs the config.
  }
  return resolveLocale(setting, deps.systemLocale ?? detectSystemLocale(deps.env));
}

/** The configuration of the data folder, or `undefined` when it cannot be read. */
async function readConfig(
  dataDir: string,
): Promise<Awaited<ReturnType<typeof loadConfig>> | undefined> {
  try {
    return await loadConfig(dataPaths(dataDir).config);
  } catch {
    return undefined;
  }
}

/**
 * The `ot` command line. Returns the exit code: 0 good, 1 the command failed, 2 wrong usage.
 * Never calls `process.exit` and never reads `process.*`, see {@link CliDeps}.
 */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  let usageProblem: string | undefined;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    usageProblem = error instanceof Error ? error.message : String(error);
    parsed = { values: {}, positionals: [] };
  }
  const { values, positionals } = parsed;

  const dataDir = resolveDataDir({
    flag: values['data-dir'],
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir,
  });
  const t = await createTranslator(await localeFor(dataDir, deps));
  const version = deps.version ?? packageVersion();

  const usageError = (message: string): number => {
    deps.err(message);
    deps.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  const serviceDeps = (): ServiceCommandDeps => ({
    platform: deps.platform,
    env: deps.env,
    service: deps.serviceHost?.manager,
    // The one place the command of the service comes from: `resolveSelfCommand()`, via `otLauncher`.
    self: resolveServiceCommand(deps.otLauncher),
    confirm: deps.confirm,
    homedir: deps.homedir,
    sleep: deps.serviceHost?.sleep,
    now: deps.serviceHost?.now,
    alive: deps.serviceHost?.alive,
  });
  const runTui = async (ui: unknown): Promise<number> => {
    if (deps.serviceHost !== undefined) {
      const tuiConfig = (await readConfig(dataDir))?.tui;
      await startDaemonForTui(
        { dataDir, t, err: deps.err },
        { ...serviceDeps(), spawnDaemon: deps.serviceHost.spawnDaemon },
        tuiConfig,
      );
    }
    try {
      return await (deps.launchTui ?? launchBuiltTui)({ dataDir, ui, env: deps.env });
    } catch (error) {
      const file = (error as { readonly file?: unknown }).file;
      if (error instanceof Error && error.name === 'TuiNotBuiltError' && typeof file === 'string') {
        deps.err(t('usage.tuiNotBuilt', { file }));
        return EXIT_FAILED;
      }
      throw error;
    }
  };
  if (usageProblem !== undefined)
    return usageError(t('usage.invalidOption', { message: usageProblem }));
  if (values.help === true) {
    deps.out(t('usage.text'));
    return EXIT_OK;
  }
  if (values.version === true) {
    deps.out(version);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  if (command === undefined) {
    // `ui.bare_command: tui` (the default): a terminal gets the interface, anything else the usage.
    if (deps.interactive === true) {
      const config = await readConfig(dataDir);
      if (config?.ui.bare_command === 'tui') return await runTui(config.ui);
    }
    return usageError(t('usage.missingCommand'));
  }
  if (!isCommand(command)) return usageError(t('usage.unknownCommand', { command }));

  const context: CommandContext = {
    dataDir,
    t,
    out: deps.out,
    err: deps.err,
    overrides: deps.overrides,
    version,
  };
  try {
    switch (command) {
      case 'daemon':
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runDaemon(context, deps);
      case 'backup':
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runBackupCommand(context);
      case 'restore': {
        const [folder, ...extra] = rest;
        if (folder === undefined) return usageError(t('usage.missingBackupPath'));
        if (extra.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runRestoreCommand(context, folder);
      }
      case 'api': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingApiAction'));
        if (action !== 'rotate-token') return usageError(t('usage.unknownApiAction', { action }));
        if (args.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runApiRotateTokenCommand(context);
      }
      case 'directives': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingDirectivesAction'));
        if (!isDirectiveAction(action))
          return usageError(t('usage.unknownDirectivesAction', { action }));
        return await runDirectivesCommand(context, action, args, directivesOptions(values));
      }
      case 'profile': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingProfileAction'));
        if (action === 'exec') {
          return await runProfileExec(
            context,
            {
              clients: deps.clients,
              env: deps.env,
              cwd: deps.cwd,
              passwordPrompt: deps.passwordPrompt?.(t),
              spawn: deps.execSpawn,
              signals: deps.execSignals,
            },
            args,
          );
        }
        const shimHost = {
          launcher: deps.otLauncher,
          platform: deps.platform,
          homedir: deps.homedir,
        };
        if (action === 'shims') {
          return await runProfileShims(
            context,
            { env: deps.env, host: shimHost, confirm: deps.confirm },
            args,
            shimsOptions(values),
          );
        }
        if (!isProfileAction(action))
          return usageError(t('usage.unknownProfileAction', { action }));
        if (values.login === true && values['no-login'] === true)
          return usageError(t('usage.profileLoginOne'));
        return await runProfileCommand(
          context,
          {
            clients: deps.clients,
            env: deps.env,
            input: deps.input,
            passwordPrompt: deps.passwordPrompt?.(t),
            shims: shimHost,
            interactive: deps.interactive,
            confirm: deps.confirm,
            cwd: deps.cwd,
            spawn: deps.execSpawn,
            signals: deps.execSignals,
          },
          action,
          args,
          profileOptions(values),
        );
      }
      case 'executor': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingExecutorAction'));
        if (!isExecutorAction(action))
          return usageError(t('usage.unknownExecutorAction', { action }));
        if (values['test-session'] === true && values['no-test-session'] === true)
          return usageError(t('usage.executorSessionOne'));
        return await runExecutorCommand(
          context,
          { clients: deps.clients, env: deps.env, testSession: deps.executorTestSession },
          action,
          args,
          executorOptions(values),
        );
      }
      case 'plugin': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingPluginAction'));
        if (!isPluginAction(action)) return usageError(t('usage.unknownPluginAction', { action }));
        return await runPluginCommand(
          context,
          {
            env: deps.env,
            cwd: deps.cwd ?? process.cwd(),
            confirm: deps.confirm,
            input: deps.input,
            askHidden: deps.askHidden,
            passwordPrompt: deps.passwordPrompt?.(t),
          },
          action,
          args,
          { project: values.project, yes: values.yes === true, json: values.json === true },
        );
      }
      case 'trajectory': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingTrajectoryAction'));
        if (!isTrajectoryAction(action))
          return usageError(t('usage.unknownTrajectoryAction', { action }));
        return await runTrajectoryCommand(
          context,
          { passwordPrompt: deps.passwordPrompt?.(t), cwd: deps.cwd },
          action,
          args,
          trajectoryOptions(values),
        );
      }
      case 'analysis': {
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runAnalysisCommand(context, {}, analysisOptions(values));
      }
      case 'service': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingServiceAction'));
        if (!isServiceAction(action))
          return usageError(t('usage.unknownServiceAction', { action }));
        if (args.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runServiceCommand(context, serviceDeps(), action, {
          noStart: values['no-start'] === true,
          json: values.json === true,
        });
      }
      case 'uninstall': {
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runUninstallCommand(context, serviceDeps(), {
          purgeData: values['purge-data'] === true,
          yes: values.yes === true,
        });
      }
      case 'init': {
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        return await runInitCommand(
          context,
          {
            ...serviceDeps(),
            spawnDaemon: deps.serviceHost?.spawnDaemon ?? noSpawn,
            find: deps.serviceHost?.find,
            adapters: deps.adapters,
            // The interface is only offered in a terminal; `runTui` also checks the daemon again.
            openTui: deps.interactive === true ? (ui) => runTui(ui) : undefined,
          },
          { noTui: values['no-tui'] === true },
        );
      }
      case 'adapters': {
        const [action, ...args] = rest;
        if (action === undefined) return usageError(t('usage.missingAdaptersAction'));
        if (!isAdaptersAction(action))
          return usageError(t('usage.unknownAdaptersAction', { action }));
        if (action === 'status' && args.length > 0)
          return usageError(t('usage.tooManyArguments', { command }));
        const unknown = args.find((name) => !isManagedClient(name));
        if (unknown !== undefined)
          return usageError(t('usage.unknownAdaptersClient', { client: unknown }));
        return await runAdaptersCommand(
          context,
          {
            platform: deps.platform,
            env: deps.env,
            find: deps.serviceHost?.find,
            adapters: deps.adapters,
          },
          action,
          { json: values.json === true, clients: args },
        );
      }
      case 'tui': {
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        if (deps.interactive !== true) return usageError(t('usage.tuiNeedsTerminal'));
        // A config that cannot be read is not an error here: the TUI reads the same defaults.
        return await runTui((await readConfig(dataDir))?.ui ?? {});
      }
      case 'chat': {
        if (rest.length > 0) return usageError(t('usage.tooManyArguments', { command }));
        const type = values.type ?? 'project';
        const repo = values.repo ?? (type === 'project' ? deps.cwd : undefined);
        if (type === 'project' && repo === undefined) return usageError(t('usage.missingRepo'));
        if (deps.input === undefined) return usageError(t('usage.noInput'));
        return await runChatCommand(context, {
          type,
          repo,
          base: values.base,
          name: values.name,
          newProject: values['new-project'],
          input: deps.input,
          signal: deps.signal,
        });
      }
    }
  } catch (error) {
    deps.err(
      t('errors.prefix', { message: error instanceof Error ? error.message : String(error) }),
    );
    return EXIT_FAILED;
  }
}

type ParsedValues = ReturnType<typeof parseCliArgs>['values'];

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      'data-dir': { type: 'string' },
      repo: { type: 'string' },
      base: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
      'new-project': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      // The options of `ot directives`.
      scenario: { type: 'string' },
      kind: { type: 'string' },
      role: { type: 'string', multiple: true },
      'rule-key': { type: 'string' },
      'rule-value': { type: 'string' },
      suspends: { type: 'string' },
      replaces: { type: 'string' },
      from: { type: 'string' },
      until: { type: 'string' },
      for: { type: 'string' },
      forever: { type: 'boolean' },
      reason: { type: 'string' },
      all: { type: 'boolean' },
      // The options of `ot profile` (`kind`, `all` are shared).
      provider: { type: 'string' },
      client: { type: 'string' },
      'api-key-env': { type: 'string' },
      'api-key-stdin': { type: 'boolean' },
      'accept-notice': { type: 'boolean' },
      'check-login': { type: 'boolean' },
      login: { type: 'boolean' },
      'no-login': { type: 'boolean' },
      json: { type: 'boolean' },
      // The options of `ot profile shims` (`json` is shared).
      install: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      shell: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      // The options of `ot plugin` (`yes`, `json` are shared).
      project: { type: 'string' },
      // The options of `ot executor` (`role`, `all`, `json` are shared).
      effort: { type: 'string' },
      family: { type: 'string' },
      as: { type: 'string' },
      'local-url': { type: 'string' },
      'local-server': { type: 'string' },
      'test-session': { type: 'boolean' },
      'no-test-session': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      profile: { type: 'string' },
      // The options of `ot analysis` (`scenario`, `from`, `json` are shared).
      to: { type: 'string' },
      'group-by': { type: 'string' },
      'compare-from': { type: 'string' },
      'compare-to': { type: 'string' },
      'compare-scenario': { type: 'string' },
      // The options of `ot trajectory` (`json` is not used there).
      unit: { type: 'string' },
      content: { type: 'string' },
      out: { type: 'string' },
      // The options of `ot service` and `ot uninstall` (`json`, `yes` are shared).
      'no-start': { type: 'boolean' },
      'purge-data': { type: 'boolean' },
      // The option of `ot init`.
      'no-tui': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
}

function analysisOptions(values: ParsedValues): AnalysisOptions {
  return {
    from: values.from,
    to: values.to,
    groupBy: values['group-by'],
    scenario: values.scenario,
    compareFrom: values['compare-from'],
    compareTo: values['compare-to'],
    compareScenario: values['compare-scenario'],
    json: values.json === true,
  };
}

function trajectoryOptions(values: ParsedValues): TrajectoryOptions {
  return { unit: values.unit, content: values.content, out: values.out };
}

function directivesOptions(values: ParsedValues): DirectivesOptions {
  return {
    scenario: values.scenario,
    kind: values.kind,
    role: values.role ?? [],
    ruleKey: values['rule-key'],
    ruleValue: values['rule-value'],
    suspends: values.suspends,
    replaces: values.replaces,
    from: values.from,
    until: values.until,
    for: values.for,
    forever: values.forever === true,
    reason: values.reason,
    all: values.all === true,
  };
}

function profileOptions(values: ParsedValues): ProfileOptions {
  return {
    kind: values.kind,
    provider: values.provider,
    apiKeyEnv: values['api-key-env'],
    apiKeyStdin: values['api-key-stdin'] === true,
    acceptNotice: values['accept-notice'] === true,
    client: values.client,
    all: values.all === true,
    checkLogin: values['check-login'] === true,
    login: values.login === true ? true : values['no-login'] === true ? false : undefined,
    json: values.json === true,
  };
}

function shimsOptions(values: ParsedValues): ShimsOptions {
  return {
    install: values.install === true,
    uninstall: values.uninstall === true,
    shell: values.shell,
    yes: values.yes === true,
    json: values.json === true,
  };
}

function executorOptions(values: ParsedValues): ExecutorOptions {
  return {
    effort: values.effort,
    family: values.family,
    as: values.as,
    localUrl: values['local-url'],
    localServer: values['local-server'],
    roles: values.role ?? [],
    testSession:
      values['test-session'] === true
        ? true
        : values['no-test-session'] === true
          ? false
          : undefined,
    dryRun: values['dry-run'] === true,
    profile: values.profile,
    all: values.all === true,
    json: values.json === true,
  };
}

async function runDaemon(context: CommandContext, deps: CliDeps): Promise<number> {
  const handle = await startDaemon({
    dataDir: context.dataDir,
    overrides: deps.overrides,
    signal: deps.signal,
    version: context.version,
    passwordPrompt: deps.passwordPrompt?.(context.t),
  });
  // Before the first message: a signal that arrives right now must still be announced.
  deps.signal?.addEventListener(
    'abort',
    () => {
      context.out(context.t('daemon.stopping'));
    },
    { once: true },
  );
  const status = handle.status();
  context.out(context.t('daemon.running', { pid: status.pid, dataDir: status.dataDir }));
  if (handle.vaultLocked) context.err(context.t('daemon.vaultLocked'));
  // A pending promise does not keep Node alive, and with `backup.when: manual` the daemon has no
  // timer at all (the HTTP server will hold the process later): this one does, until the stop.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);
  try {
    await handle.stopped;
  } finally {
    clearInterval(keepAlive);
  }
  context.out(context.t('daemon.stopped'));
  return EXIT_OK;
}

/**
 * Reads a line from the terminal without echo. Not covered by automated tests: it needs a real TTY
 * (checked by hand). The question is written to stderr so stdout stays clean for scripts.
 */
export function readHidden(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    output.write(question);
    const mute = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const lines = createInterface({ input, output: mute, terminal: true });
    let answered = false;
    lines.once('line', (line) => {
      answered = true;
      lines.close();
      output.write('\n');
      resolve(line);
    });
    // In raw mode Ctrl+C reaches readline, not the process: without this the prompt would hang.
    // Give up the prompt and pass the interrupt on, so the entry point stops as usual.
    lines.once('SIGINT', () => {
      lines.close();
      process.kill(process.pid, 'SIGINT');
    });
    lines.once('close', () => {
      if (!answered) {
        output.write('\n');
        resolve(undefined);
      }
    });
  });
}

/** [proposta] The master password is asked only on a terminal; piped input gets no prompt. */
function terminalPasswordPrompt(t: TFunction): PasswordPrompt {
  return async ({ attempt, maxAttempts }) => {
    const answer = await readHidden(
      t('daemon.passwordPrompt', { attempt, max: maxAttempts }),
      process.stdin,
      process.stderr,
    );
    return answer === undefined || answer === '' ? undefined : new Secret(answer);
  };
}

/**
 * What starts `ot` again, for the commands by profile; `undefined` if unknown. Node and the real
 * path of this entry in a checkout; the executable itself, with no script, in the single one.
 */
function otLauncherOf(): OtLauncher | undefined {
  const self = resolveSelfCommand();
  if (self === undefined) return undefined;
  return { node: self.command, entry: self.args[0] };
}

/** The real manager of this platform and the real detached child (Phase 10, P3). */
function realServiceHost(): ServiceHost {
  return {
    manager: createServiceManager({
      platform: process.platform,
      env: process.env,
      homedir: homedir(),
      uid: process.getuid?.(),
      run: execRunner,
      tmpDir: tmpdir(),
    }),
    spawnDaemon: spawnDetachedDaemon,
  };
}

/** A yes or no on stderr; only `y` or `yes` (or `s`, `sim`) count as yes. */
async function terminalConfirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      lines.question(`${question} [y/N] `, resolve);
    });
    return /^(y|yes|s|sim)$/i.test(answer.trim());
  } finally {
    lines.close();
  }
}

/**
 * Whether the command line is `ot [--data-dir <dir>] profile exec ...`: there the client in the
 * terminal owns Ctrl+C (`profiles/exec.ts`), so `entry` neither aborts nor exits on it.
 */
export function isProfileExecArgv(argv: readonly string[]): boolean {
  const words: string[] = [];
  for (let at = 0; words.length < 2; at += 1) {
    const token = argv[at];
    if (token === undefined || token === '--') break;
    if (token === '--data-dir') {
      at += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    words.push(token);
  }
  return words[0] === 'profile' && words[1] === 'exec';
}

/** Whether the command line is `ot [--data-dir <dir>] profile add ... --login` (the login runs in this terminal). */
export function isProfileAddLoginArgv(argv: readonly string[]): boolean {
  const words: string[] = [];
  let login = false;
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (token === undefined || token === '--') break;
    if (token === '--data-dir') {
      at += 1;
      continue;
    }
    if (token === '--login') login = true;
    if (!token.startsWith('-') && words.length < 2) words.push(token);
  }
  return login && words[0] === 'profile' && words[1] === 'add';
}

/**
 * The program: reads `process.argv` and sets the exit code. Runs by itself when this file is the
 * script (`isMainModule`); the single executable calls it from `sea/main.ts`.
 */
export async function entry(): Promise<void> {
  const argv = process.argv.slice(2);
  const exec = isProfileExecArgv(argv);
  // `profile add --login`: the client's login in the terminal owns Ctrl+C there too.
  const ownsCtrlC = exec || isProfileAddLoginArgv(argv);
  // A swap whose applier died is finished or undone before anything else (Phase 10, P8).
  if (isSeaProcess() && !exec) await recoverAtStart({ execPath: process.execPath });
  const controller = new AbortController();
  let signals = 0;
  const onSignal = (): void => {
    signals += 1;
    // A second Ctrl+C means "now": do not wait for a stop that is stuck.
    if (signals > 1) process.exit(EXIT_FAILED);
    controller.abort(new Error('terminated by signal'));
  };
  if (!ownsCtrlC) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  const code = await main(argv, {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    signal: controller.signal,
    cwd: process.cwd(),
    input: process.stdin,
    passwordPrompt: process.stdin.isTTY ? terminalPasswordPrompt : undefined,
    otLauncher: otLauncherOf(),
    confirm: process.stdin.isTTY ? terminalConfirm : undefined,
    askHidden: process.stdin.isTTY
      ? (question) => readHidden(question, process.stdin, process.stderr)
      : undefined,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    serviceHost: realServiceHost(),
  });
  process.exitCode = code;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

/** Runs only when this file is the program (also through the `ot` symlink the package manager makes). */
function isMainModule(): boolean {
  // The single executable starts `entry()` itself, in `sea/main.ts`; its `argv[1]` is not a module.
  if (isSeaProcess()) return false;
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void entry();
}
