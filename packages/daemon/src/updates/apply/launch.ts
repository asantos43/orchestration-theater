// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { seaModeArgument } from '../../sea/self-command.js';
import type { InstallLayout } from './layout.js';

/** The arguments of the applier: the internal mode and the journal that says what to do. */
export function applierArguments(layout: InstallLayout): string[] {
  return [seaModeArgument('apply-update'), '--journal', layout.journal];
}

/**
 * Starts the applier (Phase 10, P8): the new executable, in the internal mode `apply-update`,
 * detached from this process (it must outlive the daemon, which shuts down right after), with no
 * window and no stdio. It runs from `applierExe` and not from `layout.stagingExe`, because the
 * swap renames the staged file and a running executable cannot be renamed on Windows [N: from the
 * documentation of the platform, not verified here]. Resolves when the process exists; rejects
 * when it could not be started.
 */
export function launchApplier(
  layout: InstallLayout,
  applierExe: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(applierExe, applierArguments(layout), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
