// SPDX-License-Identifier: MPL-2.0
import type { EventLog } from '@otheater/core';
import type { DaemonConfig } from './config.js';
import { applyHotSections, splitByReload } from './config-hot.js';
import type { Logger } from './logger.js';
import { writeSituation } from './situations.js';

/**
 * The one way a write of `config.yaml` reaches the running daemon (P23 of Phase 7, N188, N202 (c),
 * N208 item 3). `PUT /v1/config`, the confirmation of the setup assistant and the cadastro of an
 * Executor all edit the file through `config-edit.ts`, which hands back the validated result; each
 * of them then gives that result and the dotted paths it wrote to the reloader, which
 * - splits the paths into the ones that apply at once and the ones that wait for a restart
 *   (`config-hot.ts`);
 * - copies the hot parts into the configuration the daemon runs with, in place;
 * - lets the daemon re-read what it copied at the start (`onHot`: the spending caps);
 * - writes the event `config.changed {hot, restart}` when something was hot.
 * A hand edit of the file does not come through here: it waits for the restart.
 */

/** What a write of the file tells the reloader. */
export interface ConfigChange {
  /** The validated configuration the write produced (what `editConfigFile` returns). */
  readonly next: DaemonConfig;
  /** The dotted paths the write set or removed. */
  readonly paths: readonly string[];
}

export interface ConfigReloadResult {
  /** The paths that already changed the running daemon. */
  readonly hot: readonly string[];
  /** The paths the file holds and the daemon reads at its next start. */
  readonly restart: readonly string[];
  readonly appliesOn: 'hot' | 'restart' | 'mixed';
}

export interface ConfigReloader {
  /** Takes the hot paths in, without announcing it: for the caller that writes its own event first. */
  readonly apply: (change: ConfigChange) => Promise<ConfigReloadResult>;
  /** Writes `config.changed` for a result of {@link ConfigReloader.apply}; nothing when no path was hot. */
  readonly announce: (result: ConfigReloadResult) => Promise<void>;
  /** `apply` and `announce`. */
  readonly reload: (change: ConfigChange) => Promise<ConfigReloadResult>;
}

export interface ConfigReloaderOptions {
  /** The configuration the daemon runs with. */
  readonly config: DaemonConfig;
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: Logger;
  /**
   * Runs after the hot paths were copied in, with them, for what the daemon built from the
   * configuration at the start and can read again (the spending caps). It never fails the write:
   * the file is already written, so an error is logged and the paths stay hot.
   */
  readonly onHot?: ((hot: readonly string[]) => Promise<void> | void) | undefined;
}

export function createConfigReloader(options: ConfigReloaderOptions): ConfigReloader {
  const { config, events, logger, onHot } = options;
  const apply = async (change: ConfigChange): Promise<ConfigReloadResult> => {
    const { hot, restart } = splitByReload(change.paths);
    if (hot.length > 0) {
      applyHotSections(config, change.next, hot);
      try {
        await onHot?.(hot);
      } catch (error) {
        logger.error(
          { err: error, hot },
          'config reload: could not apply the hot paths everywhere',
        );
      }
    }
    const appliesOn = restart.length === 0 ? 'hot' : hot.length === 0 ? 'restart' : 'mixed';
    return { hot, restart, appliesOn };
  };
  const announce = async (result: ConfigReloadResult): Promise<void> => {
    if (result.hot.length === 0) return;
    await writeSituation(events, logger, 'config.changed', {
      hot: [...result.hot],
      restart: [...result.restart],
    });
  };
  return {
    apply,
    announce,
    reload: async (change) => {
      const result = await apply(change);
      await announce(result);
      return result;
    },
  };
}

/** The type the services take: only what they need of the reloader. */
export type ConfigReload = Pick<ConfigReloader, 'reload'>['reload'];
