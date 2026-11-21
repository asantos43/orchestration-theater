// SPDX-License-Identifier: MPL-2.0
import { createNodeDaemonDirectory } from '@otheater/client/node';
import type { Resource } from 'i18next';
import { directoryConnector, type DaemonConnector } from './daemon-connection.js';
import { applyInkPatches, type InkPatchDeps, type InkPatchOutcome } from './ink-patch.js';
import type { SystemLocaleEnv } from './locale.js';
import type { RunningTui } from './run.js';
import { parseUiSettings } from './settings.js';
import type { ProcessHost } from './terminal.js';

export interface StartTuiOptions {
  /** The data folder of the daemon (discovery reads the API address and token from it). */
  readonly dataDir?: string | undefined;
  /** The `ui` object of the configuration, as the launcher read it. Read tolerantly. */
  readonly ui?: unknown;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly process?: ProcessHost | undefined;
  readonly env?: SystemLocaleEnv | undefined;
  readonly connector?: DaemonConnector | undefined;
  readonly inkPatchDeps?: InkPatchDeps | undefined;
  readonly catalogs?: Resource | undefined;
  readonly interactive?: boolean | undefined;
}

export interface StartedTui extends RunningTui {
  readonly patch: InkPatchOutcome;
}

/**
 * Starts the TUI. The order matters: the patches of Ink are decided and the module hook is
 * registered BEFORE the first import of Ink (the `run.js` module imports it), because Node loads a
 * module once. When the patches are refused (another Ink version, no hook) the TUI starts anyway,
 * on the original Ink, and says so on the screen.
 */
export async function startTui(options: StartTuiOptions): Promise<StartedTui> {
  const settings = parseUiSettings(options.ui);
  const patch = await applyInkPatches(settings.render.inkPatches, options.inkPatchDeps);
  const { startTuiApp } = await import('./run.js');
  const connector =
    options.connector ??
    directoryConnector(
      createNodeDaemonDirectory(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    );
  const running = await startTuiApp({
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    connector,
    settings,
    patch,
    process: options.process,
    env: options.env,
    catalogs: options.catalogs,
    interactive: options.interactive,
  });
  return { ...running, patch };
}
