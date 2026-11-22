// SPDX-License-Identifier: MPL-2.0
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveSecretPaths,
  type LaunchOptions,
  type LaunchWrapper,
  type RolePolicy,
  type Sandbox,
  type SandboxCapabilities,
} from '@otheater/core';
import { resolveMcpBridge, secretPathEntries, type ClientId, type DaemonConfig } from './config.js';

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
  /**
   * With `sandbox.mcp_bridge` resolved to `unix` (N161): the Unix socket the framework MCP server
   * also listens on, in the one folder the sandbox lets a client connect to. Else `undefined`.
   */
  readonly mcpSocket: string | undefined;
  close(): Promise<void>;
}

/** Name of the socket of the framework MCP server in its folder (short: macOS allows 104 bytes). */
export const MCP_SOCKET_NAME = 'mcp.sock';

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
  /**
   * Called every time a client process is wrapped with `allowNestedUserNamespaces` (N129,
   * `clients.codex.inner_sandbox: nested`), so the daemon can warn that the write denies of layer 3
   * are weaker for that process.
   */
  readonly onNestedUserNamespaces?: (info: NestedUserNamespaces) => void;
  /** Default `process.platform`; resolves `sandbox.mcp_bridge: auto`. */
  readonly platform?: NodeJS.Platform;
  /**
   * The folder of the MCP socket, already made and already in the `unixSocketDirs` of the sandbox,
   * when the bridge is `unix`. The wiring owns it from here: `close()` removes it.
   */
  readonly mcpSocketDir?: string;
}

/** What {@link SandboxWiringInput.onNestedUserNamespaces} is told. */
export interface NestedUserNamespaces {
  readonly client: ClientId;
  readonly worktree: string;
}

/**
 * N129: the clients whose process layer 3 opens to nested user namespaces, by `clients.<id>`.
 * Only Codex has the key, and only the value `nested` asks for it.
 */
export function nestedUserNamespacesFor(config: DaemonConfig, client: string): boolean {
  return client === 'codex' && config.clients.codex.inner_sandbox === 'nested';
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
  const mode = resolveMcpBridge(config.sandbox.mcp_bridge, input.platform ?? process.platform);
  const bridge = mode === 'proxy';
  // Without a folder (a caller that made none, the tests) the unix bridge is no bridge, like `off`.
  const socketDir = mode === 'unix' ? input.mcpSocketDir : undefined;
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
        const nested = nestedUserNamespacesFor(config, profile.client);
        if (nested) input.onNestedUserNamespaces?.({ client: 'codex', worktree: cwd });
        return sandbox.wrap({
          launch: spec,
          policy,
          worktree: cwd,
          profileDirs: [profile.dir],
          // The managed ACP adapters (P13) run from `<data>/adapters`, inside the secret `<data>`.
          readPaths: [join(dataDir, 'adapters')],
          extraWritePaths,
          secretPaths,
          domains: [...provider, ...extraDomains, ...own],
          ...(ports.length === 0 ? {} : { loopbackPorts: ports }),
          ...(nested ? { allowNestedUserNamespaces: true } : {}),
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
    mcpSocket: socketDir === undefined ? undefined : join(socketDir, MCP_SOCKET_NAME),
    close: async () => {
      try {
        await sandbox.close();
      } finally {
        if (socketDir !== undefined) rmSync(socketDir, { recursive: true, force: true });
      }
    },
  };
}
