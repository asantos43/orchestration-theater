// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { DEFAULT_GIT_IDENTITY, DEFAULT_GIT_TIMEOUT_MS } from './git.js';

/**
 * Configuration of the git `Vcs` adapter (`adapters.vcs: git`). Every default is a key
 * (project rule); the composition point passes the validated value to `GitVcs`. [proposta]
 */
export const GitVcsConfigSchema = z.strictObject({
  /** The git executable; looked up in `PATH` when it is a bare name. */
  binary: z.string().min(1).default('git'),
  /** Ceiling for one git command; past it the command is killed and the call fails `Transient`. */
  timeoutMs: z.int().min(1).max(3_600_000).default(DEFAULT_GIT_TIMEOUT_MS),
  /** Identity written on the commits of the daemon; the user's own git identity is never used. */
  identity: z
    .strictObject({
      name: z.string().min(1).default(DEFAULT_GIT_IDENTITY.name),
      email: z.string().min(1).default(DEFAULT_GIT_IDENTITY.email),
    })
    .default(DEFAULT_GIT_IDENTITY),
  /**
   * Directory under which the empty folder that replaces the user's git configuration (global
   * config, home, hooks) is created, once per process and removed at exit. Default: the system
   * temporary directory; the daemon can point it inside its data directory.
   */
  isolationRoot: z.string().min(1).optional(),
  /** Copy the files of `.worktreeinclude` into each new worktree. */
  worktreeInclude: z.boolean().default(true),
});

export type GitVcsConfigInput = z.input<typeof GitVcsConfigSchema>;
export type GitVcsConfig = z.output<typeof GitVcsConfigSchema>;
