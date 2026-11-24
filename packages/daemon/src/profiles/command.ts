// SPDX-License-Identifier: MPL-2.0
import { createInterface } from 'node:readline';
import {
  hasErrorCode,
  isLockableSecretVault,
  PROFILE_KINDS,
  Secret,
  type ClientAdapter,
  type ProfileKind,
} from '@otheater/core';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { compose, productionClients } from '../compose.js';
import { loadConfig, type ProfileAddLoginMode } from '../config.js';
import type { ClientFactory } from '../clients.js';
import { unlockVault, type PasswordPrompt } from '../daemon.js';
import { InstanceLock, releaseOnFailure } from '../instance-lock.js';
import { dataPaths, ensureDataDir, type Env } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
import { runProfileExec, type ExecSignals, type ExecSpawn } from './exec.js';
import { roleListsOf } from './role-lists.js';
import { syncAfterProfileChange, type ShimHost } from './shims-command.js';
import {
  ProfileService,
  profileSettingsOf,
  type AddProfileResult,
  type DrainResult,
  type ProfileSummary,
  type RemoveResult,
} from './service.js';

export const PROFILE_ACTIONS = ['add', 'list', 'drain', 'remove'] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

export function isProfileAction(name: string): name is ProfileAction {
  return (PROFILE_ACTIONS as readonly string[]).includes(name);
}

/** What `ot profile` takes from the command line (parsed by `cli.ts`). */
export interface ProfileOptions {
  /** `add`: `token_plan` (default) or `api`. */
  readonly kind?: string | undefined;
  /** `add`: provider of the account; the default is known only for Claude Code and Codex. */
  readonly provider?: string | undefined;
  /** `add --kind api`: the NAME of the environment variable that holds the key (never the key). */
  readonly apiKeyEnv?: string | undefined;
  /** `add --kind api`: read the key from the first line of the standard input. */
  readonly apiKeyStdin: boolean;
  /** `add`: the second-subscription notice was read and the Producer goes on. */
  readonly acceptNotice: boolean;
  /**
   * `add`: `--login` logs in right after the account is made, `--no-login` does not; either one
   * overrides `profiles.add.login` for this command. Without them the key decides.
   */
  readonly login?: boolean | undefined;
  /** `list`: only this client. */
  readonly client?: string | undefined;
  /** `list`: also the removed profiles. */
  readonly all: boolean;
  /** `list`: ask each client whether the profile has a login (a call to the client). */
  readonly checkLogin: boolean;
  readonly json: boolean;
}

/** What the command needs from outside, so a test runs it without a process or a terminal. */
export interface ProfileCommandDeps {
  /** Builds the adapters (default: the real clients found in `PATH`). Tests pass the fake. */
  readonly clients?: ClientFactory | undefined;
  readonly env: Env;
  /** Where `--api-key-stdin` reads from. */
  readonly input?: NodeJS.ReadableStream | undefined;
  /** Asks the master password when the vault is locked. */
  readonly passwordPrompt?: PasswordPrompt | undefined;
  /**
   * Where `ot` runs from, for the commands by profile (P28b): with it, `add` and `remove` keep
   * `<data>/bin` in step when `profiles.shims.mode` is `auto`. Without it (tests), they do not.
   */
  readonly shims?: ShimHost | undefined;
  /**
   * The terminal, for the login that goes with `add` (2026-11-22): `interactive` is true when the
   * input and the output are a terminal (`profiles.add.login: ask` asks only then, and `auto` logs
   * in only then); `confirm` asks a yes or no. `cwd`, `spawn` and `signals` are those of
   * `ot profile exec`, which does the login. Tests pass fakes.
   */
  readonly interactive?: boolean | undefined;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly cwd?: string | undefined;
  readonly spawn?: ExecSpawn | undefined;
  readonly signals?: ExecSignals | undefined;
}

/**
 * What `add` decides about the login of the new account, from the flags, the key
 * `profiles.add.login` and the terminal: `login` goes at once, `ask` waits for the answer of the
 * person, `none` does nothing. [proposta] An explicit `--login` runs wherever it is typed (the
 * person asked); the key alone (`ask`, `auto`) never starts a login without a terminal, and never
 * with `--json`, where the client's own text would break the JSON.
 */
export function loginDecision(input: {
  readonly mode: ProfileAddLoginMode;
  readonly flag: boolean | undefined;
  readonly json: boolean;
  readonly interactive: boolean;
  readonly canAsk: boolean;
  /** The account is a subscription one with no login yet (an API account, or one logged in, is not). */
  readonly needsLogin: boolean;
}): 'login' | 'ask' | 'none' {
  if (!input.needsLogin || input.flag === false) return 'none';
  if (input.flag === true) return 'login';
  if (input.json || !input.interactive) return 'none';
  if (input.mode === 'auto') return 'login';
  if (input.mode === 'ask') return input.canAsk ? 'ask' : 'none';
  return 'none';
}

/**
 * Why `profiles.add.login: auto` did not start the login of a new account (N273, 2026-11-22), or
 * `undefined` when it was not skipped. Skipped means: the key says `auto`, no flag was typed, the
 * account needs a login, and the login did not go because of `--json` or because there is no
 * terminal. `ask` and `off` skip nothing that the person was promised, so they say nothing.
 */
export function loginSkippedReason(input: {
  readonly mode: ProfileAddLoginMode;
  readonly flag: boolean | undefined;
  readonly json: boolean;
  readonly interactive: boolean;
  readonly needsLogin: boolean;
}): 'json' | 'no_terminal' | undefined {
  if (input.mode !== 'auto' || input.flag !== undefined || !input.needsLogin) return undefined;
  if (input.json) return 'json';
  return input.interactive ? undefined : 'no_terminal';
}

/** [proposta] The provider of an account of a client whose account has only one possible provider. */
const DEFAULT_PROVIDER: Readonly<Record<string, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** The first line of a stream, or `undefined` when it has none. */
async function firstLine(input: NodeJS.ReadableStream): Promise<string | undefined> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return undefined;
  } finally {
    lines.close();
  }
}

/**
 * `ot profile <add|list|drain|remove>`. [proposta] Like `ot directives`, the terminal works on the
 * data directory by itself, so with a daemon running it refuses (the live control of a running
 * daemon needs the daemon's own channel, which is not built). There is no UI (N121): text, or JSON
 * with `--json`. The API key is never an argument: it comes from an environment variable the
 * caller names (`--api-key-env`) or from the standard input (`--api-key-stdin`), goes straight to
 * the vault and is never printed.
 */
export async function runProfileCommand(
  context: CommandContext,
  deps: ProfileCommandDeps,
  action: ProfileAction,
  args: readonly string[],
  options: ProfileOptions,
): Promise<number> {
  const pending: PendingLogin = {};
  const code = await runProfileAction(context, deps, action, args, options, pending);
  if (code !== EXIT_OK || pending.profileId === undefined) return code;
  return await loginAfterAdd(context, deps, pending.profileId, pending.decision === 'ask');
}

/** The login `add` leaves for after the store is closed and the lock released. */
interface PendingLogin {
  profileId?: string;
  decision?: 'login' | 'ask';
}

/**
 * The login of a new account (2026-11-22). [proposta] It is `ot profile exec <id> login`, the
 * command the terminal interface shows for a login that needs a terminal: the official CLI of the
 * client, in this terminal, with the environment of the profile. It needs no daemon (`exec` takes
 * no lock) and works for Claude Code, Codex and OpenCode, whose `login` words the adapters map.
 * It runs after `add` closed the store, so `exec` opens it as it does alone. The account stays
 * whatever the login does; a login that did not end well says how to repeat it.
 */
async function loginAfterAdd(
  context: CommandContext,
  deps: ProfileCommandDeps,
  profileId: string,
  ask: boolean,
): Promise<number> {
  const { t } = context;
  if (ask) {
    const yes =
      deps.confirm === undefined
        ? false
        : await deps.confirm(t('profile.askLogin', { id: profileId }));
    if (!yes) {
      context.out(t('profile.loginSkipped', { id: profileId }));
      return EXIT_OK;
    }
  }
  context.out(t('profile.loginStarting', { id: profileId }));
  const code = await runProfileExec(
    context,
    {
      clients: deps.clients,
      env: deps.env,
      cwd: deps.cwd,
      passwordPrompt: deps.passwordPrompt,
      spawn: deps.spawn,
      signals: deps.signals,
    },
    [profileId, 'login'],
  );
  if (code === EXIT_OK) {
    context.out(t('profile.loginDone', { id: profileId }));
    return EXIT_OK;
  }
  context.err(t('profile.loginFailed', { id: profileId, code: String(code) }));
  return EXIT_FAILED;
}

async function runProfileAction(
  context: CommandContext,
  deps: ProfileCommandDeps,
  action: ProfileAction,
  args: readonly string[],
  options: ProfileOptions,
  pending: PendingLogin,
): Promise<number> {
  const { t } = context;
  const usage = (key: string, vars: Record<string, string> = {}): number => {
    context.err(t(key, vars));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  // The arguments are checked before the store is touched.
  const kind = options.kind ?? 'token_plan';
  if (!(PROFILE_KINDS as readonly string[]).includes(kind)) return usage('usage.profileKind');
  switch (action) {
    case 'list':
      if (args.length > 0) return usage('usage.profileTooMany');
      break;
    case 'add': {
      const [client, name, ...extra] = args;
      if (client === undefined || name === undefined) return usage('usage.profileNeedsClientName');
      if (extra.length > 0) return usage('usage.profileTooMany');
      if (options.provider === undefined && DEFAULT_PROVIDER[client] === undefined) {
        return usage('usage.profileNeedsProvider');
      }
      const keySources = Number(options.apiKeyEnv !== undefined) + Number(options.apiKeyStdin);
      if (keySources > 1) return usage('usage.profileKeyOne');
      if (kind === 'api' && keySources === 0) return usage('usage.profileApiNeedsKey');
      if (kind !== 'api' && keySources > 0) return usage('usage.profileKeyOnlyApi');
      if (options.apiKeyStdin && deps.input === undefined) return usage('usage.noInput');
      if (options.login === true && options.json) return usage('usage.profileLoginJson');
      break;
    }
    case 'drain':
    case 'remove': {
      const [id, ...extra] = args;
      if (id === undefined) return usage('usage.profileNeedsId');
      if (extra.length > 0) return usage('usage.profileTooMany');
      break;
    }
  }

  // The key is read before anything is opened, so a missing one stops the command early.
  let apiKey: Secret | undefined;
  if (action === 'add' && kind === 'api') {
    const raw =
      options.apiKeyEnv === undefined
        ? deps.input === undefined
          ? undefined
          : await firstLine(deps.input)
        : deps.env[options.apiKeyEnv];
    const value = raw?.trim() ?? '';
    if (value === '') {
      context.err(
        t(options.apiKeyEnv === undefined ? 'profile.keyStdinEmpty' : 'profile.keyEnvEmpty', {
          name: options.apiKeyEnv ?? '',
        }),
      );
      return EXIT_FAILED;
    }
    apiKey = new Secret(value);
  }

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  let lock: InstanceLock;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (hasErrorCode(error, 'CONFLICT')) {
      context.err(t('profile.daemonRunning'));
      return EXIT_FAILED;
    }
    throw error;
  }
  const registries = buildDaemonRegistries();
  const composition = await releaseOnFailure(lock, () =>
    compose(config, {
      dataDir: paths.dataDir,
      events: { registry: registries.events, unknownType: config.events.unknown_type },
      ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    }),
  );
  // No daemon in this process: there is no `daemon.started` to wait for, and `close` waits for the writes.
  composition.situations.open();
  try {
    const adapters = new Map<string, ClientAdapter>();
    if (composition.launcher !== undefined) {
      const factory = deps.clients ?? productionClients(config, { env: deps.env });
      for (const adapter of factory({
        launcher: composition.launcher,
        clock: composition.clock,
        transport: composition.transport,
        paths,
        logger: composition.logger,
        situations: composition.situations,
      })) {
        adapters.set(adapter.id, adapter);
      }
    }
    const backend =
      composition.adapters.find((adapter) => adapter.port === 'SecretVault')?.id ??
      config.adapters.vault;
    const service = new ProfileService({
      store: composition.store,
      vault: composition.vault,
      vaultBackend: backend,
      clock: composition.clock,
      logger: composition.logger,
      situations: composition.situations,
      paths,
      settings: profileSettingsOf(config),
      adapters: (client) => adapters.get(client),
      transport: () => composition.transport,
      roleLists: roleListsOf(config, composition.store),
    });

    // A locked vault is opened only when the command touches a key.
    const removing =
      action === 'remove' ? await composition.store.profiles.get(args[0] ?? '') : undefined;
    const needsVault = apiKey !== undefined || (removing?.secretRef ?? null) !== null;
    if (needsVault && isLockableSecretVault(composition.vault)) {
      await unlockVault(
        composition.vault,
        deps.passwordPrompt,
        composition.logger,
        composition.situations,
      );
    }

    const first = args[0] ?? '';
    switch (action) {
      case 'add': {
        const client = first;
        const name = args[1] ?? '';
        const result = await service.add({
          client,
          name,
          kind: kind as ProfileKind,
          provider: options.provider ?? DEFAULT_PROVIDER[client] ?? '',
          ...(apiKey === undefined ? {} : { apiKey }),
          acceptNotice: options.acceptNotice,
        });
        const loginInput =
          result.status === 'added'
            ? {
                mode: config.profiles.add.login,
                flag: options.login,
                json: options.json,
                interactive: deps.interactive === true,
                needsLogin: result.profile.kind === 'token_plan' && result.login !== 'logged_in',
              }
            : undefined;
        // N273: `auto` that did not log in says so (the line, or the JSON) and records the event.
        const skipped =
          loginInput === undefined || result.status !== 'added'
            ? undefined
            : loginSkippedReason(loginInput);
        if (skipped !== undefined && result.status === 'added') {
          composition.situations.record('profile.login.skipped', {
            profileId: result.profile.id,
            reason: skipped,
          });
        }
        const code = reportAdd(context, options, service, result, skipped);
        if (result.status === 'added' && loginInput !== undefined) {
          const decision = loginDecision({ ...loginInput, canAsk: deps.confirm !== undefined });
          if (decision !== 'none') {
            pending.profileId = result.profile.id;
            pending.decision = decision;
          }
        }
        if (result.status !== 'needs_notice') {
          await syncAfterProfileChange(context, {
            composition,
            paths,
            config,
            env: deps.env,
            host: deps.shims,
            trigger: 'add',
            profileId: result.profile.id,
            quiet: options.json,
          });
        }
        return code;
      }
      case 'list': {
        const list = await service.list({
          ...(options.client === undefined ? {} : { client: options.client }),
          includeRemoved: options.all,
          checkLogin: options.checkLogin,
        });
        return reportList(context, options, list);
      }
      case 'drain': {
        // No session can be running here: the daemon is stopped (it holds the lock), so the rows
        // still `active` are leftovers, and `on_timeout` applies to them at once.
        const result = await service.drain(first, { timeoutMs: 0 });
        return reportDrain(context, options, result);
      }
      case 'remove': {
        const result = await service.remove(first, { timeoutMs: 0 });
        const code = reportRemove(context, options, result);
        await syncAfterProfileChange(context, {
          composition,
          paths,
          config,
          env: deps.env,
          host: deps.shims,
          trigger: 'remove',
          profileId: result.profile.id,
          quiet: options.json,
        });
        return code;
      }
    }
  } finally {
    await composition.close().catch(() => undefined);
    await lock.release();
  }
}

function printJson(context: CommandContext, value: unknown): void {
  context.out(JSON.stringify(value, null, 2));
}

function reportAdd(
  context: CommandContext,
  options: ProfileOptions,
  service: ProfileService,
  result: AddProfileResult,
  loginSkipped?: 'json' | 'no_terminal',
): number {
  const { t, out } = context;
  if (result.status === 'needs_notice') {
    if (options.json) printJson(context, result);
    else {
      out(
        t('profile.needsNotice', {
          provider: result.notice.provider,
          existing: result.notice.existing.join(', '),
        }),
      );
    }
    return EXIT_FAILED;
  }
  const { profile } = result;
  const loginCommand = `ot profile exec ${profile.id} login`;
  if (options.json) {
    // N273: with `--json` the warning is part of the JSON, not a loose line on the stderr.
    printJson(
      context,
      loginSkipped === undefined
        ? result
        : { ...result, loginSkipped: { reason: loginSkipped, command: loginCommand } },
    );
    return EXIT_OK;
  }
  out(t('profile.added', { id: profile.id, kind: profile.kind, provider: profile.provider }));
  if (result.hasSecret) {
    out(t('profile.addedKey', { backend: result.secretBackend ?? service.vaultBackend }));
  }
  if (result.login !== null) out(t('profile.addedLogin', { state: result.login }));
  if (loginSkipped !== undefined) {
    context.err(t('profile.loginNotStarted', { id: profile.id, command: loginCommand }));
  }
  if (result.notice !== null) {
    out(
      t('profile.noticeAccepted', {
        provider: result.notice.provider,
        existing: result.notice.existing.join(', '),
      }),
    );
  }
  return EXIT_OK;
}

function lineOf(context: CommandContext, summary: ProfileSummary): string {
  const { profile } = summary;
  const login = summary.login === undefined ? '' : ` login=${summary.login ?? 'none'}`;
  return context.t('profile.line', {
    id: profile.id,
    state: profile.state,
    kind: profile.kind,
    provider: profile.provider,
    key: summary.hasSecret ? ' key=vault' : '',
    login,
    valid: summary.executors.valid,
    invalid: summary.executors.invalid,
  });
}

function reportList(
  context: CommandContext,
  options: ProfileOptions,
  list: readonly ProfileSummary[],
): number {
  if (options.json) {
    printJson(context, list);
    return EXIT_OK;
  }
  if (list.length === 0) context.out(context.t('profile.none'));
  for (const summary of list) context.out(lineOf(context, summary));
  return EXIT_OK;
}

function reportDrain(
  context: CommandContext,
  options: ProfileOptions,
  result: DrainResult,
): number {
  if (options.json) {
    printJson(context, result);
    return EXIT_OK;
  }
  context.out(
    context.t(`profile.drained_${result.outcome}`, {
      id: result.profile.id,
      sessions: result.sessions,
    }),
  );
  return EXIT_OK;
}

function reportRemove(
  context: CommandContext,
  options: ProfileOptions,
  result: RemoveResult,
): number {
  if (options.json) {
    printJson(context, result);
    return EXIT_OK;
  }
  const { t, out } = context;
  out(t('profile.removed', { id: result.profile.id }));
  out(t(`profile.dir_${result.dir}`));
  if (result.loggedOut) out(t('profile.loggedOut'));
  if (result.secretDeleted) out(t('profile.secretDeleted'));
  if (result.executorsInvalidated.length > 0) {
    out(t('profile.executorsInvalid', { ids: result.executorsInvalidated.join(', ') }));
  }
  return EXIT_OK;
}
