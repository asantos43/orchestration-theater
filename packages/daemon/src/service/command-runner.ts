// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';

/** What a program printed and how it ended. A program that cannot be started gives `spawnFailed`. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the program could not be started at all (not found, not allowed). */
  readonly spawnFailed?: boolean | undefined;
}

export interface RunOptions {
  readonly timeoutMs?: number | undefined;
}

/**
 * Runs the program of the system that manages services (`systemctl`, `launchctl`, `schtasks`).
 * It never rejects: the caller reads `code`. Tests give a fake that records the calls, so no test
 * but the ones switched on by `OT_TEST_REAL_SERVICE` ever reaches the real manager.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** The real runner: `execFile` (no shell), no window on Windows, a timeout so a stuck manager cannot hang `ot`. */
export const execRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ code, stdout, stderr });
          return;
        }
        resolve({
          code: -1,
          stdout,
          stderr: stderr === '' ? error.message : stderr,
          spawnFailed: true,
        });
      },
    );
  });
