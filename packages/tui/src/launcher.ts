// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEA_INTERNAL_PREFIX, isSeaProcess } from '@otheater/client/node';
import { SIGNAL_EXIT_CODES, EXIT_SIGNALS } from './terminal.js';
import { parseUiSettings, type UiRuntimeSettings } from './settings.js';

/**
 * Starts the TUI in its own Node process, with the V8 flags of `ui.runtime` (decision N37). The
 * young heap limit and the old heap cap are process flags: they cannot be set once the process is
 * running, which is why the daemon CLI does not import the app, it starts it.
 *
 * This module is the only one of the package the daemon imports (`@otheater/tui/launcher`). It
 * loads neither Ink nor React, so `ot` stays light for every other command, and the package does
 * not depend on the daemon at run time: there is no cycle.
 */

/** The environment variable that carries the `ui` settings (JSON) to the TUI process. */
export const UI_ENV = 'OT_TUI_UI';

/** The V8 flags for `ui.runtime`. */
export function runtimeFlags(runtime: UiRuntimeSettings): string[] {
  const flags = [`--max-semi-space-size=${String(runtime.maxSemiSpaceMB)}`];
  if (runtime.maxOldSpaceMB !== undefined) {
    flags.push(`--max-old-space-size=${String(runtime.maxOldSpaceMB)}`);
  }
  return flags;
}

export interface TuiLaunchOptions {
  /** The data folder of the daemon the TUI connects to. */
  readonly dataDir: string;
  /** The `ui` object of the configuration. Read tolerantly (see `parseUiSettings`). */
  readonly ui?: unknown;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The Node binary. Default: the one that runs this code. */
  readonly execPath?: string | undefined;
  /** The file the process runs. Default: `main.js` next to this module. */
  readonly mainFile?: string | undefined;
  /**
   * Whether this is the single executable (Phase 10, P1). Default: {@link isSeaProcess}. There the
   * process is the executable again, in its `tui` internal mode, and the V8 flags travel in
   * `NODE_OPTIONS`: an argument before the mode would be taken for the person's.
   */
  readonly sea?: boolean | undefined;
}

export interface TuiCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The script the process runs; absent in the single executable, where there is none. */
  readonly mainFile?: string | undefined;
}

/** The mode of the executable that runs the TUI (`--ot-internal=tui`). */
export const TUI_INTERNAL_MODE = 'tui';

export function defaultMainFile(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

/** `NODE_OPTIONS` with `flags` added to what the environment already had. */
function withNodeOptions(env: NodeJS.ProcessEnv, flags: readonly string[]): string {
  const current = env.NODE_OPTIONS;
  return [...(current === undefined || current === '' ? [] : [current]), ...flags].join(' ');
}

/** The command line and environment of the TUI process. Pure: nothing is started. */
export function buildTuiCommand(options: TuiLaunchOptions): TuiCommand {
  const settings = parseUiSettings(options.ui);
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  env[UI_ENV] = JSON.stringify(options.ui ?? {});
  const flags = runtimeFlags(settings.runtime);
  if (options.sea ?? isSeaProcess()) {
    env.NODE_OPTIONS = withNodeOptions(env, flags);
    return {
      command: options.execPath ?? process.execPath,
      args: [`${SEA_INTERNAL_PREFIX}${TUI_INTERNAL_MODE}`, '--data-dir', options.dataDir],
      env,
    };
  }
  const mainFile = options.mainFile ?? defaultMainFile();
  return {
    command: options.execPath ?? process.execPath,
    args: [...flags, mainFile, '--data-dir', options.dataDir],
    env,
    mainFile,
  };
}

/** The package was not built: there is no `main.js` to run. */
export class TuiNotBuiltError extends Error {
  override name = 'TuiNotBuiltError';
  readonly file: string;

  constructor(file: string) {
    super(`The TUI is not built: ${file} does not exist (run "pnpm build")`);
    this.file = file;
  }
}

/** The part of `child_process.spawn` the launcher uses. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LaunchDeps {
  readonly spawn?: SpawnFn | undefined;
  readonly exists?: ((file: string) => boolean) | undefined;
  readonly process?: Pick<NodeJS.Process, 'on' | 'off'> | undefined;
}

/**
 * Runs the TUI and resolves with its exit code (a process ended by a signal gives 128 plus the
 * signal, as a shell shows it). Signals sent to this process are passed on to it. Rejects with
 * {@link TuiNotBuiltError} when `main.js` does not exist.
 */
export async function launchTui(options: TuiLaunchOptions, deps: LaunchDeps = {}): Promise<number> {
  const command = buildTuiCommand(options);
  const main = command.mainFile;
  if (main !== undefined && !(deps.exists ?? existsSync)(main)) throw new TuiNotBuiltError(main);

  const host = deps.process ?? process;
  const child = (deps.spawn ?? spawn)(command.command, command.args, {
    stdio: 'inherit',
    env: command.env,
  });
  const forwards = EXIT_SIGNALS.map((signal) => {
    const forward = (): void => {
      child.kill(signal);
    };
    host.on(signal, forward);
    return [signal, forward] as const;
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code !== null) resolve(code);
        else if (signal !== null && signal in SIGNAL_EXIT_CODES) {
          resolve(SIGNAL_EXIT_CODES[signal as keyof typeof SIGNAL_EXIT_CODES]);
        } else resolve(1);
      });
    });
  } finally {
    for (const [signal, forward] of forwards) host.off(signal, forward);
  }
}
