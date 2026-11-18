// SPDX-License-Identifier: MPL-2.0
import {
  resolveSecretPaths,
  type LaunchOptions,
  type LaunchWrapper,
  type RolePolicy,
  type Sandbox,
  type SandboxCapabilities,
} from '@otheater/core';
import { secretPathEntries, type ClientId, type DaemonConfig } from './config.js';

/**
 * [proposta, N] The domains each client needs to work at all (its API and its login). Not measured
 * against the real clients (the tests run nothing real, N57); written from what each one is known to
 * talk to. A client that talks to another provider (OpenCode with any model) needs that domain in
 * `sandbox.extra_domains`.
 */
export const PROVIDER_DOMAINS: Readonly<Record<ClientId, readonly string[]>> = {
  'claude-code': ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com'],
  codex: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
  opencode: ['opencode.ai', 'models.dev'],
};

/** Runs a command of the tools (`restricted_shell`, `run_tests`, `install_deps`) inside the sandbox. */
export type CommandConfiner = (launch: LaunchOptions, worktree: string) => Promise<LaunchOptions>;

/** What the daemon hands to the clients and to the tools when layer 3 is on. */
export interface SandboxWiring {
  /** What layer 3 guarantees: handed to the clients, so `guarantee()` counts it. */
  readonly capabilities: SandboxCapabilities;
  /**
   * The launch wrapper of the clients. `loopback` gives the URLs of the daemon's own servers (the
   * framework MCP) the confined client must reach: they are allowed as `localhost:<port>` and, with
   * `sandbox.mcp_bridge: proxy` (N115), bridged into the sandbox on the same port.
   */
  launchWrapper(loopback?: () => readonly string[]): LaunchWrapper;
  /** The same confinement for the commands of the tools. */
  readonly confineCommand: CommandConfiner;
  close(): Promise<void>;
}

/** The port of a URL that names the loopback, else `undefined`. Pure. */
export function loopbackPort(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined;
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
  return Number(port);
}

/** `localhost:<port>` for a URL that names the loopback, else `undefined`. Pure. */
export function loopbackRule(url: string): string | undefined {
  const port = loopbackPort(url);
  return port === undefined ? undefined : `localhost:${String(port)}`;
}

export interface SandboxWiringInput {
  readonly sandbox: Sandbox;
  readonly config: DaemonConfig;
  /** Absolute home directory of the account (for `~` in `security.secret_paths`). */
  readonly home: string;
  readonly dataDir: string;
}

const NO_NETWORK: Pick<RolePolicy, 'writeScope' | 'network'> = {
  writeScope: 'worktree',
  network: { allow: [] },
};

/** Builds what the daemon hands out from a `Sandbox` and the config. Pure apart from the sandbox. */
export function buildSandboxWiring(input: SandboxWiringInput): SandboxWiring {
  const { sandbox, config, home, dataDir } = input;
  const entries = secretPathEntries(config);
  const secretPaths = resolveSecretPaths({
    home,
    dataDir,
    add: entries.add,
    remove: entries.remove,
  });
  const extraWritePaths = config.sandbox.extra_write_paths;
  const extraDomains = config.sandbox.extra_domains;
  const bridge = config.sandbox.mcp_bridge === 'proxy';
  return {
    capabilities: sandbox.capabilities(),
    launchWrapper:
      (loopback = () => []) =>
      ({ profile, policy, cwd, spec }) => {
        const own = loopback()
          .map(loopbackRule)
          .filter((rule): rule is string => rule !== undefined);
        const ports = bridge
          ? loopback()
              .map(loopbackPort)
              .filter((port): port is number => port !== undefined)
          : [];
        const provider =
          (PROVIDER_DOMAINS as Readonly<Record<string, readonly string[] | undefined>>)[
            profile.client
          ] ?? [];
        return sandbox.wrap({
          launch: spec,
          policy,
          worktree: cwd,
          profileDirs: [profile.dir],
          extraWritePaths,
          secretPaths,
          domains: [...provider, ...extraDomains, ...own],
          ...(ports.length === 0 ? {} : { loopbackPorts: ports }),
        });
      },
    // [proposta] A command of the tools writes only in its worktree and reaches only the domains
    // of `sandbox.extra_domains` (an `install_deps` needs its registry there).
    confineCommand: (launch, worktree) =>
      sandbox.wrap({
        launch,
        policy: NO_NETWORK,
        worktree,
        profileDirs: [],
        extraWritePaths,
        secretPaths,
        domains: extraDomains,
      }),
    close: () => sandbox.close(),
  };
}
