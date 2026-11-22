// SPDX-License-Identifier: MPL-2.0
import { PROCESS_LAUNCHER_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

/** Identity of this adapter (architecture 5.18, "Versão dos contratos"). */
export const WINDOWS_PROCESS_LAUNCHER_ADAPTER: Adapter = {
  id: 'windows',
  implements: { port: 'ProcessLauncher', range: `^${PROCESS_LAUNCHER_PORT_VERSION}` },
};

/** File name of the launcher (`native/job-launcher`, crate `ot-job-launcher`). */
export const JOB_LAUNCHER_FILE = 'ot-job-launcher.exe';

/**
 * What to do with a `.cmd` shim of npm (`codex.cmd`, `claude-agent-acp.cmd`), which the launcher
 * refuses: `resolve` reads it and runs `node.exe <script>` instead; `refuse` fails with the
 * reason. [proposta] `processes.windows_shims` in the daemon.
 */
export const WINDOWS_SHIM_MODES = ['resolve', 'refuse'] as const;
export type WindowsShimMode = (typeof WINDOWS_SHIM_MODES)[number];

/**
 * Configuration of the Windows launcher (`adapters.process_launcher: windows`).
 *
 * `launcherPath` is the absolute path of `ot-job-launcher.exe`: the adapter is built around that
 * file and refuses to be built without one (the daemon finds it with {@link locateJobLauncher}).
 * [proposta] A key and not a constant, so a test and an installer can point to their own copy.
 * `shims` ({@link WINDOWS_SHIM_MODES}): default `resolve`.
 */
export const WindowsLauncherConfigSchema = z.strictObject({
  launcherPath: z.string().min(1),
  shims: z.enum(WINDOWS_SHIM_MODES).default('resolve'),
});

/** What the caller writes. */
export type WindowsLauncherConfigInput = z.input<typeof WindowsLauncherConfigSchema>;
/** The validated configuration. */
export type WindowsLauncherConfig = z.output<typeof WindowsLauncherConfigSchema>;
