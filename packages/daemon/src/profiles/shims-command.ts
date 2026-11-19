// SPDX-License-Identifier: MPL-2.0
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { compose, type Composition } from '../compose.js';
import { loadConfig, type DaemonConfig } from '../config.js';
import { dataPaths, ensureDataDir, type DataPaths, type Env } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
import {
  binOnPath,
  RC_SHELLS,
  rcFileOf,
  rcLineOf,
  rcShellOf,
  shimPlatformOf,
  syncShims,
  updateRcFile,
  type OtLauncher,
  type RcShell,
  type ShimSyncResult,
} from './shims.js';

/**
 * `ot profile shims <sync|path>` and the sync that `ot profile add` and `remove` run (Phase 5, P28b,
 * N159; owner, 2026-11-19). Like `ot profile exec`, it does not take the instance lock: it reads the
 * profiles and writes only `<data>/bin` and, after a yes, the shell's rc file.
 *
 * Owner's decision on `PATH`: the daemon gives the choice and says what to do. `path` with no option
 * explains both ways (the line by hand, or `--install`); `--install` writes the line in a marked
 * block of the rc file, only after a yes (`--yes`, or the question in the terminal), and then says
 * how to use it now (a new terminal, or reading the rc file again).
 */

export const SHIMS_ACTIONS = ['sync', 'path'] as const;
export type ShimsAction = (typeof SHIMS_ACTIONS)[number];

/** Where `ot` runs from and where the person's home is; the CLI gives the real ones, tests fakes. */
export interface ShimHost {
  /** What the scripts call: Node and the entry of `ot`. `undefined` when it cannot be known. */
  readonly launcher: OtLauncher | undefined;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

export interface ShimsOptions {
  readonly install: boolean;
  readonly uninstall: boolean;
  readonly shell?: string | undefined;
  readonly yes: boolean;
  readonly json: boolean;
}

export interface ShimsCommandDeps {
  readonly env: Env;
  readonly host: ShimHost;
  /** Asks a yes or no in the terminal; `undefined` when there is no terminal to ask in. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
}

export type ShimsTrigger = 'add' | 'remove' | 'sync';

export interface ProfileShimsResult extends ShimSyncResult {
  readonly binOnPath: boolean;
}

/**
 * Makes `<data>/bin` match the profiles that are not removed, and records what changed: a
 * `profile.warning` `shim_conflict` per name some other program has, and one `profile.shims.synced`.
 */
export async function syncProfileShims(input: {
  readonly composition: Pick<Composition, 'store' | 'situations'>;
  readonly paths: DataPaths;
  readonly config: DaemonConfig;
  readonly env: Env;
  readonly host: ShimHost & { readonly launcher: OtLauncher };
  readonly trigger: ShimsTrigger;
}): Promise<ProfileShimsResult> {
  const { composition, paths, host } = input;
  const platform = shimPlatformOf(host.platform);
  const records = await composition.store.profiles.list({ states: ['active', 'draining'] });
  const result = await syncShims({
    binDir: paths.bin,
    dataDir: paths.dataDir,
    prefix: input.config.profiles.shims.prefix,
    launcher: host.launcher,
    platform,
    env: input.env,
    profiles: records.map((record) => ({
      id: record.id,
      client: record.client,
      name: record.name,
    })),
  });
  const onPath = binOnPath(input.env, platform, paths.bin);
  for (const conflict of result.conflicts) {
    composition.situations.record('profile.warning', {
      profileId: conflict.profileId,
      kind: 'shim_conflict',
      detail: conflict.name,
    });
  }
  if (result.written.length + result.removed.length + result.conflicts.length > 0) {
    composition.situations.record('profile.shims.synced', {
      trigger: input.trigger,
      written: [...result.written],
      removed: [...result.removed],
      conflicts: result.conflicts.map((conflict) => conflict.name),
      binOnPath: onPath,
    });
  }
  return { ...result, binOnPath: onPath };
}

/**
 * The sync after `ot profile add` or `remove`, when `profiles.shims.mode` is `auto`: a failure here
 * never fails the command (the profile is already registered or removed); it is a `profile.warning`
 * `shim_failed` and a line on stderr.
 */
export async function syncAfterProfileChange(
  context: CommandContext,
  input: {
    readonly composition: Pick<Composition, 'store' | 'situations'>;
    readonly paths: DataPaths;
    readonly config: DaemonConfig;
    readonly env: Env;
    readonly host: ShimHost | undefined;
    readonly trigger: 'add' | 'remove';
    readonly profileId: string;
    readonly quiet: boolean;
  },
): Promise<void> {
  const { host } = input;
  if (input.config.profiles.shims.mode !== 'auto' || host?.launcher === undefined) return;
  const { t } = context;
  try {
    const result = await syncProfileShims({
      ...input,
      host: { ...host, launcher: host.launcher },
    });
    if (input.quiet) return;
    for (const name of result.written) context.out(t('profile.shimsMade', { name }));
    for (const conflict of result.conflicts) {
      context.err(t('profile.shimsConflict', { name: conflict.name, at: conflict.at }));
    }
    if (result.written.length > 0 && !result.binOnPath) {
      context.out(t('profile.shimsNotOnPath', { bin: result.binDir }));
    }
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    const detail = typeof code === 'string' ? code : 'error';
    input.composition.situations.record('profile.warning', {
      profileId: input.profileId,
      kind: 'shim_failed',
      detail,
    });
    context.err(t('profile.shimsFailed', { reason: detail }));
  }
}

function isShimsAction(name: string): name is ShimsAction {
  return (SHIMS_ACTIONS as readonly string[]).includes(name);
}

function isRcShell(name: string): name is RcShell {
  return (RC_SHELLS as readonly string[]).includes(name);
}

/** How to read the rc file again in the terminal that is open. */
function reloadOf(shell: RcShell, file: string): string {
  return `${shell === 'fish' ? 'source' : '.'} '${file.replaceAll("'", `'\\''`)}'`;
}

export async function runProfileShims(
  context: CommandContext,
  deps: ShimsCommandDeps,
  args: readonly string[],
  options: ShimsOptions,
): Promise<number> {
  const { t } = context;
  const usage = (key: string, vars: Record<string, string> = {}): number => {
    context.err(t(key, vars));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };
  const [action, ...extra] = args;
  if (action === undefined) return usage('usage.missingShimsAction');
  if (!isShimsAction(action)) return usage('usage.unknownShimsAction', { action });
  if (extra.length > 0) return usage('usage.profileTooMany');
  if (action === 'sync' && (options.install || options.uninstall || options.shell !== undefined)) {
    return usage('usage.shimsPathOnly');
  }
  if (options.install && options.uninstall) return usage('usage.shimsInstallOne');
  if (options.shell !== undefined && !isRcShell(options.shell)) {
    return usage('usage.shimsShell', { shells: RC_SHELLS.join(', ') });
  }

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  const { host } = deps;
  const platform = shimPlatformOf(host.platform);

  const withComposition = async <T>(work: (composition: Composition) => Promise<T>): Promise<T> => {
    const registries = buildDaemonRegistries();
    const composition = await compose(config, {
      dataDir: paths.dataDir,
      events: { registry: registries.events, unknownType: config.events.unknown_type },
      ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    });
    composition.situations.open();
    try {
      return await work(composition);
    } finally {
      await composition.close().catch(() => undefined);
    }
  };

  if (action === 'sync') {
    if (config.profiles.shims.mode === 'off') {
      context.err(t('profile.shimsOff'));
      return EXIT_FAILED;
    }
    if (host.launcher === undefined) {
      context.err(t('profile.shimsNoLauncher'));
      return EXIT_FAILED;
    }
    const launcher = host.launcher;
    const result = await withComposition((composition) =>
      syncProfileShims({
        composition,
        paths,
        config,
        env: deps.env,
        host: { ...host, launcher },
        trigger: 'sync',
      }),
    );
    if (options.json) {
      context.out(JSON.stringify(result, null, 2));
      return EXIT_OK;
    }
    context.out(
      t('profile.shimsSynced', {
        bin: result.binDir,
        written: result.written.length,
        kept: result.kept.length,
        removed: result.removed.length,
      }),
    );
    for (const conflict of result.conflicts) {
      context.err(t('profile.shimsConflict', { name: conflict.name, at: conflict.at }));
    }
    if (!result.binOnPath) context.out(t('profile.shimsNotOnPath', { bin: result.binDir }));
    return EXIT_OK;
  }

  // `path`.
  const onPath = binOnPath(deps.env, platform, paths.bin);
  if (platform === 'win32') {
    if (options.install || options.uninstall) {
      context.err(t('profile.shimsWindowsByHand'));
      return EXIT_FAILED;
    }
    context.out(t(onPath ? 'profile.shimsOnPath' : 'profile.shimsOffPath', { bin: paths.bin }));
    context.out(t('profile.shimsWindowsHow', { bin: paths.bin }));
    return EXIT_OK;
  }
  const shell = options.shell ?? rcShellOf(deps.env);

  if (!options.install && !options.uninstall) {
    context.out(t(onPath ? 'profile.shimsOnPath' : 'profile.shimsOffPath', { bin: paths.bin }));
    if (shell === undefined) {
      context.out(t('profile.shimsHowNoShell', { line: rcLineOf('bash', paths.bin) }));
      return EXIT_OK;
    }
    const file = rcFileOf(shell, deps.env, host.homedir);
    context.out(
      t('profile.shimsHow', {
        shell,
        file,
        line: rcLineOf(shell, paths.bin),
        reload: reloadOf(shell, file),
      }),
    );
    return EXIT_OK;
  }

  if (shell === undefined) return usage('usage.shimsNeedShell', { shells: RC_SHELLS.join(', ') });
  const file = rcFileOf(shell, deps.env, host.homedir);
  if (options.install && !options.yes) {
    if (deps.confirm === undefined) {
      context.err(t('profile.shimsNeedYes', { file }));
      return EXIT_FAILED;
    }
    const yes = await deps.confirm(
      t('profile.shimsConfirm', { file, line: rcLineOf(shell, paths.bin) }),
    );
    if (!yes) {
      context.out(t('profile.shimsCancelled'));
      return EXIT_FAILED;
    }
  }
  const change = await updateRcFile(
    file,
    options.install ? { install: true, shell, binDir: paths.bin } : { install: false },
  );
  if (change === 'added' || change === 'replaced' || change === 'removed') {
    await withComposition((composition) => {
      composition.situations.record('profile.shims.rc_changed', { shell, change });
      return Promise.resolve();
    });
  }
  context.out(t(`profile.shimsRc_${change}`, { file }));
  if (change === 'added' || change === 'replaced') {
    context.out(t('profile.shimsReload', { reload: reloadOf(shell, file) }));
  }
  return EXIT_OK;
}
