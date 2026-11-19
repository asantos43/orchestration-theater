// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';

/**
 * Removes a temp folder of a test. On Windows the folder can stay busy for a few milliseconds after
 * the last process that used it (as cwd or with an open file) is gone, so the removal retries. This
 * is tolerance for that delay only: the tests check that the processes ended before they get here.
 * The wait grows by `retryDelay` on each try: 10 tries wait up to 5.5 s in all, and 20 tries (on
 * Windows, where a loaded runner was seen busy past 5.5 s) up to 21 s, inside the 60 s hook timeout.
 *
 * On Windows a folder still busy after the 21 s (seen on the cross of 2026-11-19, twice, with every
 * process of the test checked gone) is left in the temp folder of the runner, which the job throws
 * away: the test does not fail for it. The warning lists the `node` and `conhost` processes alive
 * then, so the log of the CI says who held it. Elsewhere the error stands.
 */
export async function removeDir(dir: string): Promise<void> {
  const windows = process.platform === 'win32';
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: windows ? 20 : 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!windows || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
    console.warn(
      `[removeDir] ${dir} still busy (${code}) after 21 s; left for the runner. Processes:\n${await windowsProcesses()}`,
    );
  }
}

/** The `node` and `conhost` processes of the machine, with parent and command line (diagnosis). */
function windowsProcesses(): Promise<string> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='conhost.exe'\" | " +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-Table -AutoSize | Out-String -Width 400';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (error, stdout) => {
        resolve(error === null ? stdout : `(the list failed: ${error.message})`);
      },
    );
  });
}
