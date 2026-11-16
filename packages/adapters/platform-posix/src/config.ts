// SPDX-License-Identifier: MPL-2.0
import { PROCESS_LAUNCHER_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

/** Identity of this adapter (architecture 5.18, "Versão dos contratos"). */
export const POSIX_PROCESS_LAUNCHER_ADAPTER: Adapter = {
  id: 'posix',
  implements: { port: 'ProcessLauncher', range: `^${PROCESS_LAUNCHER_PORT_VERSION}` },
};

/**
 * How the launcher limits memory: `none` (no limit; `memoryLimitBytes` is refused) or
 * `systemd-scope` (Linux with a systemd user manager: each process runs in a transient scope with
 * `MemoryMax`).
 */
export const MEMORY_LIMIT_MODES = ['none', 'systemd-scope'] as const;
export type MemoryLimitMode = (typeof MEMORY_LIMIT_MODES)[number];

/**
 * Configuration of the posix launcher (`adapters.process_launcher: posix`).
 *
 * [proposta] every default is a configuration key with several modes (project rule), so the
 * memory limit is a key even though the architecture only fixes the process group.
 */
export const PosixLauncherConfigSchema = z.strictObject({
  memoryLimit: z.enum(MEMORY_LIMIT_MODES).default('none'),
});

/** What the user may write (defaults optional). */
export type PosixLauncherConfigInput = z.input<typeof PosixLauncherConfigSchema>;
/** The validated configuration, every default filled in. */
export type PosixLauncherConfig = z.output<typeof PosixLauncherConfigSchema>;
