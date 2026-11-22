// SPDX-License-Identifier: MPL-2.0
import { UI_ENV } from './launcher.js';
import { parseUiSettings } from './settings.js';
import { startTui } from './start.js';
import { endProcess } from './terminal.js';

/**
 * The body of the process the launcher starts (`node [flags] main.js --data-dir <dir>`, or the
 * single executable in its `tui` mode). It lives here, apart from `main.ts`, so the executable can
 * call it as a function: a script with a top-level `await` cannot be bundled into the one CommonJS
 * file a SEA runs. The `ui` settings come in the environment, as JSON: the launcher already read
 * them to set the V8 flags, and a process cannot change those after it started.
 */
export function parseDataDir(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--data-dir');
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseUi(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Runs the TUI until it ends, then ends the process. `argv` is what follows the script (or the mode). */
export async function runTuiMain(argv: readonly string[]): Promise<void> {
  const ui = parseUi(process.env[UI_ENV]);
  const running = await startTui({
    dataDir: parseDataDir(argv),
    ui,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    process,
  });
  const code = await running.done;
  // A socket to the daemon or a timer could hold the process after the TUI is gone, and a process
  // with no terminal is an orphan that spins: the end is forced after `ui.runtime.exitGraceMs`.
  endProcess(code, parseUiSettings(ui).runtime.exitGraceMs, {
    exit: (exitCode) => process.exit(exitCode),
    setExitCode: (exitCode) => {
      process.exitCode = exitCode;
    },
  });
}
