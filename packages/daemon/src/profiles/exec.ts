// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import {
  commonArgsFor,
  commonNames,
  isLockableSecretVault,
  translateCommonArgs,
  type ClientAdapter,
  type CommonArgsOverrides,
  type Profile,
  type ProfileCli,
} from '@otheater/core';
import { EXIT_FAILED, EXIT_USAGE, type CommandContext } from '../commands.js';
import { buildClientEnv, type ClientEnvSettings, type ClientFactory } from '../clients.js';
import { compose, productionClients } from '../compose.js';
import { loadConfig, type DaemonConfig, type ProfileExecEnvInheritMode } from '../config.js';
import { unlockVault, type PasswordPrompt } from '../daemon.js';
import { dataPaths, ensureDataDir, type Env } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
import { profileSecretEnv } from './secret-env.js';

/**
 * `ot profile exec <client>/<profile> [--] [args...]` (Phase 5, P28a, N159; owner, 2026-11-19):
 * runs the official CLI of a client inside one profile, in the person's terminal, with the
 * environment of that profile (its directory, and the key of an API profile from the vault). The
 * commands by profile of P28b (`codex-personal`) are scripts that only call this; no secret is in
 * them, nor in any file.
 *
 * The common words (`login`, `logout`, `status`, `run`, `--model`, and those of
 * `profiles.commands` and `profiles.options`) are translated into the client's own; anything else
 * goes as it was, and after `--` everything does (`codex-personal -- login --device-auth`).
 *
 * [proposta] Unlike the other `ot profile` actions, `exec` does not take the instance lock: it only
 * reads the profile and writes two events, so it runs with the daemon up (the store is SQLite in WAL
 * mode, where a second writer waits for the first [S: SQLite docs]). It refuses a `removed`
 * profile, and warns on a `draining` one.
 */

/** What ended the child: its code, or the signal that ended it. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The CLI running in the terminal. */
export interface ExecChild {
  /** Resolves when it ended; rejects when it could not start (`ENOENT`, `EACCES`). */
  readonly exited: Promise<ChildExit>;
  kill(signal: NodeJS.Signals): void;
}

export interface ExecSpawnOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}

/** Starts the CLI with the terminal's stdin, stdout and stderr. Tests pass a fake. */
export type ExecSpawn = (
  cmd: string,
  args: readonly string[],
  options: ExecSpawnOptions,
) => ExecChild;

/**
 * While the CLI runs, what the parent does with the signals: Ctrl+C reaches the CLI straight from
 * the terminal (same process group), so the parent ignores SIGINT and does not die before it; a
 * SIGTERM or SIGHUP sent to the parent goes on to the CLI. Returns what undoes it. Tests pass a fake.
 */
export type ExecSignals = (forward: (signal: NodeJS.Signals) => void) => () => void;

export interface ProfileExecDeps {
  readonly clients?: ClientFactory | undefined;
  readonly env: Env;
  /** Where the CLI runs: the folder of the terminal. */
  readonly cwd?: string | undefined;
  readonly passwordPrompt?: PasswordPrompt | undefined;
  readonly spawn?: ExecSpawn | undefined;
  readonly signals?: ExecSignals | undefined;
}

/** The real {@link ExecSpawn}: `stdio: inherit`, no shell. */
export const spawnInTerminal: ExecSpawn = (cmd, args, options) => {
  const child = spawn(cmd, [...args], {
    stdio: 'inherit',
    env: { ...options.env },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    shell: false,
  });
  const exited = new Promise<ChildExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return {
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

/** The real {@link ExecSignals}. */
export const processSignals: ExecSignals = (forward) => {
  const ignore = (): void => undefined;
  const onTerm = (): void => {
    forward('SIGTERM');
  };
  const onHup = (): void => {
    forward('SIGHUP');
  };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  return () => {
    process.off('SIGINT', ignore);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  };
};

/** The exit code of the parent: the CLI's, or 128 + the signal number when a signal ended it. */
export function exitCodeOf(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  const number = exit.signal === null ? undefined : osConstants.signals[exit.signal];
  return number === undefined ? EXIT_FAILED : 128 + number;
}

/** The common words of the config, as the core reads them. */
export function commonOverridesOf(config: DaemonConfig): CommonArgsOverrides {
  return { commands: config.profiles.commands, options: config.profiles.options };
}

/**
 * The environment of the CLI. `terminal`: the person's own, without what the adapter says points at
 * another account or profile; `client`: the one the daemon gives an Executor of this client. Then
 * the variables of the profile, then the key. Names are compared in upper case, as Windows does.
 */
export function execEnv(
  mode: ProfileExecEnvInheritMode,
  source: Env,
  clientSettings: ClientEnvSettings | undefined,
  cli: Pick<ProfileCli, 'env' | 'unsetEnv'>,
  secret: Readonly<Record<string, string>>,
): Record<string, string> {
  const base: Record<string, string> = {};
  if (mode === 'terminal') {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) base[name] = value;
    }
  } else {
    Object.assign(
      base,
      buildClientEnv(clientSettings ?? { env_inherit: 'minimal', env_allow: [], env: {} }, source),
    );
  }
  const unset = new Set(cli.unsetEnv.map((name) => name.toUpperCase()));
  const kept = Object.entries(base).filter(([name]) => !unset.has(name.toUpperCase()));
  return { ...Object.fromEntries(kept), ...cli.env, ...secret };
}

/** `<client>/<profile>`, or `undefined` when the id is not one. */
function splitId(id: string): { client: string; name: string } | undefined {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1 || id.includes('/', slash + 1)) return undefined;
  return { client: id.slice(0, slash), name: id.slice(slash + 1) };
}

export async function runProfileExec(
  context: CommandContext,
  deps: ProfileExecDeps,
  args: readonly string[],
): Promise<number> {
  const { t } = context;
  const usage = (key: string, vars: Record<string, string> = {}): number => {
    context.err(t(key, vars));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };
  const [id, ...rest] = args;
  if (id === undefined) return usage('usage.profileNeedsId');
  const parts = splitId(id);
  if (parts === undefined) return usage('usage.profileExecId', { id });

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  const registries = buildDaemonRegistries();
  const composition = await compose(config, {
    dataDir: paths.dataDir,
    events: { registry: registries.events, unknownType: config.events.unknown_type },
    ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
  });
  composition.situations.open();
  const refuse = (detail: string, key: string, vars: Record<string, string>): number => {
    composition.situations.record('profile.warning', {
      profileId: id,
      kind: 'exec_refused',
      detail,
    });
    context.err(t(key, vars));
    return EXIT_FAILED;
  };
  try {
    const record = await composition.store.profiles.get(id);
    if (record === undefined) {
      context.err(t('profile.execNotFound', { id }));
      return EXIT_FAILED;
    }
    if (record.state === 'removed') return refuse('removed', 'profile.execRemoved', { id });

    let adapter: ClientAdapter | undefined;
    if (composition.launcher !== undefined) {
      const factory = deps.clients ?? productionClients(config, { env: deps.env });
      adapter = factory({
        launcher: composition.launcher,
        clock: composition.clock,
        transport: composition.transport,
        paths,
        logger: composition.logger,
        situations: composition.situations,
      }).find((candidate) => candidate.id === parts.client);
    }
    if (adapter === undefined) {
      return refuse('no_client', 'profile.execNoClient', { client: parts.client });
    }
    if (adapter.profileCli === undefined) {
      return refuse('no_profile_cli', 'profile.execNoProfileCli', { client: parts.client });
    }

    const profile: Profile = {
      client: record.client,
      profile: record.name,
      id: record.id,
      dir: record.dir,
    };
    const cli = await adapter.profileCli(profile);
    const overrides = commonOverridesOf(config);
    const translated = translateCommonArgs(
      rest,
      commonArgsFor(cli, record.client, overrides),
      commonNames(overrides),
    );
    if (!translated.ok) {
      if (translated.reason === 'missing_value') {
        return usage('usage.profileExecMissingValue', { name: translated.name });
      }
      return usage('usage.profileExecNotForClient', {
        word: translated.kind === 'option' ? `--${translated.name}` : translated.name,
        client: record.client,
        commands: translated.available.commands.join(', ') || '-',
        options: translated.available.options.map((name) => `--${name}`).join(', ') || '-',
      });
    }

    if (record.state === 'draining') {
      composition.situations.record('profile.warning', { profileId: id, kind: 'exec_draining' });
      context.err(t('profile.execDraining', { id }));
    }

    // The key of an API profile, from the vault; a locked one asks the password first.
    if (record.secretRef !== null && isLockableSecretVault(composition.vault)) {
      await unlockVault(
        composition.vault,
        deps.passwordPrompt,
        composition.logger,
        composition.situations,
      );
    }
    const secret = await profileSecretEnv({
      store: composition.store,
      vault: composition.vault,
      apiKeyEnv: config.profiles.api_key_env,
      logger: composition.logger,
      situations: composition.situations,
    })(profile);

    const mode = config.profiles.exec.env_inherit;
    const clientSettings = (config.clients as Readonly<Record<string, ClientEnvSettings>>)[
      record.client
    ];
    const env = execEnv(mode, deps.env, clientSettings, cli, secret);
    const command = translated.command ?? 'native';
    composition.situations.record('profile.exec.started', {
      profileId: id,
      command,
      envInherit: mode,
      apiKey: Object.keys(secret).length > 0,
    });

    const startedAt = composition.clock.now();
    const run = deps.spawn ?? spawnInTerminal;
    let exit: ChildExit | undefined;
    let startError: unknown;
    const child = run(cli.cmd, [...cli.args, ...translated.args], { env, cwd: deps.cwd });
    const undo = (deps.signals ?? processSignals)((signal) => {
      child.kill(signal);
    });
    try {
      exit = await child.exited;
    } catch (error) {
      startError = error;
    } finally {
      undo();
    }
    composition.situations.record('profile.exec.ended', {
      profileId: id,
      command,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      startFailed: exit === undefined,
      durationMs: Math.max(0, Math.round(composition.clock.now() - startedAt)),
    });
    if (exit === undefined) {
      const code = (startError as { code?: unknown } | undefined)?.code;
      context.err(
        t('profile.execStartFailed', {
          cmd: cli.cmd,
          reason: typeof code === 'string' ? code : String(startError),
        }),
      );
      return code === 'ENOENT' ? 127 : 126;
    }
    return exitCodeOf(exit);
  } finally {
    await composition.close().catch(() => undefined);
  }
}
