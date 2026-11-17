// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';
import type { Profile } from './executor.js';
import type { RolePolicy, SandboxCapabilities } from './client-adapter.js';
import type { LaunchOptions } from './process-launcher.js';

/** Semver of the `Sandbox` port contract (architecture 5.18, "Versão dos contratos"). */
export const SANDBOX_PORT_VERSION = '0.1.0';

/**
 * What to confine (architecture 5.8, layer 3). [proposta] The daemon decides WHAT is allowed (the
 * worktree, the profile of the client, the secret paths, the domains) and the adapter only turns
 * it into the mechanism of the operating system, so the policy is testable without one.
 */
export interface SandboxRequest {
  /** The command to run. `cmd`, `args` and `env` go through as they are; `cwd` is where it runs. */
  readonly launch: LaunchOptions;
  /** The part of the role policy that layer 3 guarantees: `writeScope` and `network`. */
  readonly policy: Pick<RolePolicy, 'writeScope' | 'network'>;
  /** The worktree: the only place of the project the command may write. */
  readonly worktree: string;
  /**
   * The profile folder(s) of the client that runs: readable and writable even when they lie
   * inside a secret path (the data directory holds every profile; only this one is re-opened).
   */
  readonly profileDirs: readonly string[];
  /** More folders the command may write (`sandbox.extra_write_paths`). */
  readonly extraWritePaths: readonly string[];
  /** Paths the command may not READ, already resolved (`resolveSecretPaths`). */
  readonly secretPaths: readonly string[];
  /**
   * Domains allowed besides `policy.network.allow`: the provider of the client and
   * `sandbox.extra_domains`. Everything else is denied.
   */
  readonly domains: readonly string[];
}

/** Whether the mechanism of this machine works, found by trying it once (never by looking at the platform). */
export type SandboxAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Layer 3 of the permissions (architecture 5.8): confinement by the operating system, for the
 * Executor and for the shells of the daemon (5.2, "Casca de agente"). Linux and macOS have an
 * adapter (`sandbox-runtime`); Windows has none yet (N94), and the daemon then says layer 3 is
 * missing and follows `security.unenforced`.
 *
 * Contract:
 * - `capabilities()` lists the fields of the `RolePolicy` the adapter guarantees. It is the answer
 *   of `guarantee(policy, os)`; an adapter that cannot work here returns `{ fields: [] }`.
 * - `wrap` returns the command to run INSTEAD of `request.launch`: same working directory, the
 *   same environment (complete, nothing added from the daemon), no shell involved at the launcher.
 *   The same request gives the same result while the sandbox is open, so the key of a shared
 *   process (`sharedProcessKey`) stays stable per worktree.
 * - Writes outside `worktree`, `profileDirs`, `extraWritePaths` and the temporary folder of the
 *   adapter fail in the operating system. A connection to a domain outside the allowed ones fails
 *   there too. A read of a `secretPaths` entry fails, except inside `profileDirs` and `worktree`.
 * - `wrap` rejects with `AdapterUnavailable` when the mechanism does not work.
 * - `close` ends what the adapter keeps open (proxies, sockets). Idempotent.
 */
export interface Sandbox extends Adapter {
  capabilities(): SandboxCapabilities;
  /** Tries the mechanism once. The daemon asks at start-up and refuses to claim layer 3 if it fails. */
  available(): Promise<SandboxAvailability>;
  wrap(request: SandboxRequest): Promise<LaunchOptions>;
  close(): Promise<void>;
}

/** What the `ClientAdapter` hands to {@link LaunchWrapper} when it builds the launch of a client. */
export interface LaunchWrapInput {
  readonly profile: Profile;
  readonly policy: RolePolicy;
  /** The working directory of the session: the worktree. */
  readonly cwd: string;
  /** The transport of the session (`acp`...). */
  readonly via: string;
  /** The launch the adapter built, before confinement. */
  readonly spec: LaunchOptions;
}

/**
 * Turns the launch of a client into the confined launch (layer 3). The daemon builds it from the
 * `Sandbox` and its configuration and gives it to the adapters; without one the client starts as
 * built. [proposta] A function and not the `Sandbox` itself, so the core does not decide which
 * folders and domains a client needs.
 */
export type LaunchWrapper = (input: LaunchWrapInput) => Promise<LaunchOptions>;
