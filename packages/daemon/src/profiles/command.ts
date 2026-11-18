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
import { loadConfig } from '../config.js';
import type { ClientFactory } from '../clients.js';
import { unlockVault, type PasswordPrompt } from '../daemon.js';
import { InstanceLock } from '../instance-lock.js';
import { dataPaths, ensureDataDir, type Env } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
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
  const composition = await compose(config, {
    dataDir: paths.dataDir,
    events: { registry: registries.events, unknownType: config.events.unknown_type },
    ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
  });
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
        return reportAdd(context, options, service, result);
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
        return reportRemove(context, options, result);
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
  if (options.json) {
    printJson(context, result);
    return EXIT_OK;
  }
  const { profile } = result;
  out(t('profile.added', { id: profile.id, kind: profile.kind, provider: profile.provider }));
  if (result.hasSecret) {
    out(t('profile.addedKey', { backend: result.secretBackend ?? service.vaultBackend }));
  }
  if (result.login !== null) out(t('profile.addedLogin', { state: result.login }));
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
