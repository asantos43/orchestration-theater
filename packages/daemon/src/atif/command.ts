// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { hasErrorCode, isLockableSecretVault } from '@otheater/core';
import {
  API_ROUTES,
  ATIF_EXPORT_CONTENTS,
  ATIF_EXPORT_UNITS,
  AtifTrajectorySchema,
  type AtifExportContent,
  type AtifExportUnit,
} from '@otheater/protocol';
import { readApiToken, readDiscovery, writePrivateFile } from '../api/files.js';
import type { ApiFetch } from '../commands-api.js';
import { compose } from '../compose.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { loadConfig } from '../config.js';
import { unlockVault, type PasswordPrompt } from '../daemon.js';
import { InstanceLock, releaseOnFailure } from '../instance-lock.js';
import { dataPaths, ensureDataDir } from '../paths.js';
import { usageSettingsOf } from '../usage/index.js';
import { AtifExportError, AtifExporter, atifPlayFileName } from './atif-exporter.js';

export const TRAJECTORY_ACTIONS = ['export'] as const;
export type TrajectoryAction = (typeof TRAJECTORY_ACTIONS)[number];

export function isTrajectoryAction(name: string): name is TrajectoryAction {
  return (TRAJECTORY_ACTIONS as readonly string[]).includes(name);
}

/** The options of `ot trajectory export` (all of them default to `atif.export.*`). */
export interface TrajectoryOptions {
  readonly unit: string | undefined;
  readonly content: string | undefined;
  readonly out: string | undefined;
}

export interface TrajectoryDeps {
  readonly passwordPrompt?: PasswordPrompt | undefined;
  readonly fetch?: ApiFetch | undefined;
  /** What a relative `--out` is relative to (default: the current folder of the process). */
  readonly cwd?: string | undefined;
}

/**
 * `ot trajectory export <play>` (Phase 8, P5; N219). [proposta] Two paths, decided by the instance
 * lock, as `ot api rotate-token`:
 * - no daemon: this process takes the lock, opens the store and writes the files of
 *   `atif.export.unit` with the same exporter the daemon uses, and the `atif.exported` event;
 * - daemon running: the trajectory is asked of it (`GET /v1/plays/:playId/atif`, authenticated with
 *   the token of `api-token`) and written here; only the unit `play` (a file with every attempt
 *   embedded) is available, and the daemon records no event, since it wrote nothing.
 * `--out` replaces `atif.export.dir` (relative to the current folder); `--unit` and `--content`
 * replace `atif.export.unit` and `atif.export.content`.
 */
export async function runTrajectoryCommand(
  context: CommandContext,
  deps: TrajectoryDeps,
  action: TrajectoryAction,
  args: readonly string[],
  options: TrajectoryOptions,
): Promise<number> {
  const { t } = context;
  const usage = (message: string): number => {
    context.err(message);
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };
  // The arguments are checked before the data folder is touched.
  const [playId, ...extra] = args;
  if (playId === undefined) return usage(t('usage.trajectoryNeedsPlay', { action }));
  if (extra.length > 0) return usage(t('usage.trajectoryTooMany'));
  if (options.unit !== undefined && !isOneOf(ATIF_EXPORT_UNITS, options.unit)) {
    return usage(t('usage.trajectoryUnit', { values: ATIF_EXPORT_UNITS.join(', ') }));
  }
  if (options.content !== undefined && !isOneOf(ATIF_EXPORT_CONTENTS, options.content)) {
    return usage(t('usage.trajectoryContent', { values: ATIF_EXPORT_CONTENTS.join(', ') }));
  }
  const unit: AtifExportUnit | undefined = options.unit;
  const content: AtifExportContent | undefined = options.content;

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  const dir =
    options.out === undefined ? undefined : resolve(deps.cwd ?? process.cwd(), options.out);

  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (!hasErrorCode(error, 'CONFLICT')) throw error;
  }

  if (lock !== undefined) {
    const held = lock;
    const composition = await releaseOnFailure(held, () =>
      compose(config, {
        dataDir: paths.dataDir,
        ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
      }),
    );
    try {
      // `redacted` writes no text, so it needs no value of the vault; `full` masks them all.
      if (
        (content ?? config.atif.export.content) === 'full' &&
        isLockableSecretVault(composition.vault)
      ) {
        await unlockVault(
          composition.vault,
          deps.passwordPrompt,
          composition.logger,
          composition.situations,
        );
      }
      const exporter = new AtifExporter({
        store: composition.store,
        clock: composition.clock,
        vault: composition.vault,
        version: context.version ?? 'unknown',
        dataDir: paths.dataDir,
        settings: () => config.atif.export,
        pricing: () => usageSettingsOf(config).pricing,
        situations: composition.situations,
      });
      try {
        const files = await exporter.export(playId, {
          on: 'manual',
          ...(unit === undefined ? {} : { unit }),
          ...(content === undefined ? {} : { content }),
          ...(dir === undefined ? {} : { dir }),
        });
        for (const file of files) {
          context.out(
            t('trajectory.exported', { path: file.path, bytes: file.bytes, steps: file.steps }),
          );
        }
        return EXIT_OK;
      } catch (error) {
        if (!(error instanceof AtifExportError)) throw error;
        context.err(failureText(context, playId, error));
        return EXIT_FAILED;
      } finally {
        await composition.situations.idle().catch(() => undefined);
      }
    } finally {
      await composition.close().catch(() => undefined);
      await held.release();
    }
  }

  // A daemon holds the data folder: ask it.
  if ((unit ?? config.atif.export.unit) !== 'play') {
    context.err(t('trajectory.needsStoppedDaemon'));
    return EXIT_FAILED;
  }
  const discovery = await readDiscovery(paths.apiDiscovery);
  if (discovery.kind !== 'live') {
    context.err(t('api.noApi'));
    return EXIT_FAILED;
  }
  const token = await readApiToken(paths.apiToken);
  if (token === undefined) {
    context.err(t('trajectory.noToken'));
    return EXIT_FAILED;
  }
  const route = API_ROUTES.getPlayAtif;
  const query = content === undefined ? '' : `?content=${content}`;
  const path = route.path.replace(':playId', encodeURIComponent(playId));
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${discovery.info.url}${path}${query}`, {
      method: route.method,
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    context.err(t('api.unreachable', { url: discovery.info.url }));
    return EXIT_FAILED;
  }
  if (response.status === 401 || response.status === 403) {
    context.err(t('api.rejected', { status: response.status }));
    return EXIT_FAILED;
  }
  if (response.status === 404) {
    context.err(t('trajectory.noPlay', { playId }));
    return EXIT_FAILED;
  }
  if (!response.ok) {
    context.err(t('trajectory.failedOnline', { status: response.status }));
    return EXIT_FAILED;
  }
  const parsed = AtifTrajectorySchema.safeParse(await response.json());
  if (!parsed.success) {
    context.err(t('trajectory.failedOnline', { status: response.status }));
    return EXIT_FAILED;
  }
  const target = dir ?? configuredDir(paths.dataDir, config.atif.export.dir);
  await mkdir(target, { recursive: true });
  const file = join(target, atifPlayFileName(playId));
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  await writePrivateFile(file, text);
  context.out(
    t('trajectory.exported', {
      path: file,
      bytes: Buffer.byteLength(text),
      steps: parsed.data.steps.length,
    }),
  );
  return EXIT_OK;
}

function configuredDir(dataDir: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(dataDir, dir);
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function failureText(context: CommandContext, playId: string, error: AtifExportError): string {
  const { t } = context;
  if (error.reason === 'play_not_found') return t('trajectory.noPlay', { playId });
  return t('trajectory.failed', {
    reason: error.reason,
    detail: error.detail === null ? '' : `: ${error.detail}`,
  });
}
