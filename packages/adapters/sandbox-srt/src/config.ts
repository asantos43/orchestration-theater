// SPDX-License-Identifier: MPL-2.0
import { SANDBOX_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

/** Identity of this adapter (architecture 5.18, "Versão dos contratos"). */
export const SRT_SANDBOX_ADAPTER: Adapter = {
  id: 'srt',
  implements: { port: 'Sandbox', range: `^${SANDBOX_PORT_VERSION}` },
};

/**
 * Configuration of the adapter (`adapters.sandbox: srt`). The WHAT is decided by the daemon and
 * arrives in each `SandboxRequest`; these keys are only about the mechanism of this machine.
 * [proposta] Every one is a key with a default, as the project rule asks.
 */
export const SrtSandboxConfigSchema = z.strictObject({
  /**
   * Its own temporary folder: the only place besides the worktree and the profile folders where a
   * confined command may write, and the `TMPDIR` it sees. Absolute. Default: a folder of the
   * account under the temporary directory of the system (`otheater-sandbox-<uid>`).
   */
  tempDir: z.string().min(1).optional(),
  /** Path of `bwrap` (Linux). Default: the one in `PATH`. */
  bwrapPath: z.string().min(1).optional(),
  /** Path of `socat` (Linux). Default: the one in `PATH`. */
  socatPath: z.string().min(1).optional(),
  /**
   * How deep `sandbox-runtime` looks for files it must keep read-only (`.git/hooks`,
   * `.bashrc`...) under the writable folders. Default 3 (the value of the library); deeper costs
   * a longer wrap in a big worktree.
   */
  mandatoryDenySearchDepth: z.number().int().min(1).max(10).default(3),
  /**
   * macOS only (N161): folders whose Unix sockets a confined command may connect to, for the MCP
   * server of the daemon, which Seatbelt keeps off the loopback (EPERM). Absolute. The library
   * reads this list once, for every command of the process, not per command; the folder is not
   * writable from inside, so a command can reach a socket there but not create one. Ignored on
   * Linux, where the seccomp filter of the library refuses Unix sockets and the bridge is TCP (N115).
   * Default: none.
   */
  unixSocketDirs: z.array(z.string().min(1)).max(8).default([]),
});

/** What the user may write (defaults optional). */
export type SrtSandboxConfigInput = z.input<typeof SrtSandboxConfigSchema>;
/** The validated configuration, every default filled in. */
export type SrtSandboxConfig = z.output<typeof SrtSandboxConfigSchema>;
