// SPDX-License-Identifier: MPL-2.0
import { homedir } from 'node:os';
import type { LayoutFileStore } from '@otheater/client';
import {
  FileLayoutStore,
  clientLayoutFile,
  createNodeDaemonDirectory,
  resolveClientConfigDir,
  resolveDataDir,
} from '@otheater/client/node';
import type { Resource } from 'i18next';
import { directoryConnector, type DaemonConnector } from './daemon-connection.js';
import {
  FileHistoryStore,
  MemoryHistoryStore,
  inputHistoryFile,
  type HistoryStore,
} from './input/index.js';
import { applyInkPatches, type InkPatchDeps, type InkPatchOutcome } from './ink-patch.js';
import type { SystemLocaleEnv } from './locale.js';
import type { RunningTui } from './run.js';
import { parseUiSettings, type UiSettings } from './settings.js';
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
  /**
   * The file of the layout when `ui.layout.store` is `local`. Default: `layout.tui.json` in the
   * client folder (`OT_CLIENT_CONFIG_DIR`, else the config folder of the system, see
   * `resolveClientConfigDir`). A test passes its own, so the real home is never read.
   */
  readonly layoutFile?: LayoutFileStore | undefined;
  /** The history of the text box. Default: the one `ui.input.history.store` chooses. */
  readonly history?: HistoryStore | undefined;
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
      undefined,
      { layoutFile: options.layoutFile ?? defaultLayoutFile() },
    );
  const running = await startTuiApp({
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    connector,
    settings,
    patch,
    history: options.history ?? defaultHistory(settings, options.dataDir),
    process: options.process,
    env: options.env,
    catalogs: options.catalogs,
    interactive: options.interactive,
  });
  return { ...running, patch };
}

/** `layout.tui.json` in the client folder, which `OT_CLIENT_CONFIG_DIR` can move. */
function defaultLayoutFile(): LayoutFileStore {
  const configDir = resolveClientConfigDir({
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
  });
  return new FileLayoutStore(clientLayoutFile(configDir, 'tui'));
}

/** The history of the text box: a file in the data folder, or only in memory (`ui.input.history.store`). */
function defaultHistory(settings: UiSettings, dataDir: string | undefined): HistoryStore {
  const { store, size } = settings.input.history;
  if (store === 'memory') return new MemoryHistoryStore(size);
  const folder = resolveDataDir({
    explicit: dataDir,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
  });
  return new FileHistoryStore(inputHistoryFile(folder), size);
}
