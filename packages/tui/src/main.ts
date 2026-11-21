// SPDX-License-Identifier: MPL-2.0
import { UI_ENV } from './launcher.js';
import { startTui } from './start.js';

/**
 * The entry of the process the launcher starts (`node [flags] main.js --data-dir <dir>`). The
 * `ui` settings come in the environment, as JSON: the launcher already read them to set the V8
 * flags, and a process cannot change those after it started.
 */
function parseDataDir(argv: readonly string[]): string | undefined {
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

const running = await startTui({
  dataDir: parseDataDir(process.argv.slice(2)),
  ui: parseUi(process.env[UI_ENV]),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  process,
});
process.exitCode = await running.done;
