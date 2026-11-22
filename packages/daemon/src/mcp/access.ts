// SPDX-License-Identifier: MPL-2.0
import type { McpServerRef, NewEvent, RolePolicy } from '@otheater/core';

/** Name the framework server goes by in `RolePolicy.mcpServers` and in the session (5.3). */
export const FRAMEWORK_MCP_NAME = 'otheater';

/** The ids that tie an event to its play (N54); the same fields the payloads carry. */
export interface McpCorrelation {
  readonly playId?: string;
  readonly demandId?: string;
  readonly attemptId?: string;
}

/** What the daemon hands the framework server to open the door for one session of one attempt. */
export interface McpGrantInput {
  readonly attemptId: string;
  /** The role the session plays: it decides which tools it lists and may call. */
  readonly role: string;
  /**
   * The tools of the server this session may see and call, by name: the list of its role policy
   * (`RolePolicy.mcpTools`, P1). Absent: every tool the registry gives the role. [proposta] A tool
   * the policy leaves out is neither listed nor callable, which is what makes the `mcpTools` field
   * of the policy hold in the daemon layer.
   */
  readonly tools?: readonly string[];
  /**
   * The tools of the plugins active in the project this session may see and call, by the name
   * `<id>__<tool>`: what `McpAccess.pluginTools` answered for the policy of the role (P6, the
   * roles and effects of the manifest under the policy). Absent: the plugin tools follow `tools`
   * as before. A name outside it is neither listed nor callable.
   */
  readonly pluginTools?: readonly string[];
  readonly correlation: McpCorrelation;
  /**
   * The project the attempt belongs to (the scenario id): the one whose active plugins add their
   * tools to the server (Phase 9, P5). Absent: the server asks the daemon for it (`projectOf`
   * option) from the play, and a grant with no project gets no plugin tool.
   */
  readonly project?: string;
  /**
   * The worktree of the attempt: where the work tools (`restricted_shell`, `run_tests`...) run and
   * what they are confined to. A tool that needs it refuses without one.
   */
  readonly worktree?: string;
  /**
   * The domains of the role's `network.allow` (`RolePolicy.network`): the only hosts `http_get`
   * may reach. Absent or empty means none.
   */
  readonly networkAllow?: readonly string[];
  /**
   * Appends an event of this attempt to the log (the journal of the attempt). The `submit*` tools
   * write `attempt.submitted` and `attempt.submit_failed` through it.
   */
  readonly record: (event: NewEvent) => Promise<void>;
}

/** What `McpAccess.pluginTools` needs to tell which tools of the plugins a role may call. */
export interface PluginToolsQuery {
  readonly role: string;
  readonly correlation: McpCorrelation;
  /** The project, when the caller knows it; otherwise the server asks the daemon (`projectOf`). */
  readonly project?: string;
  /** The part of the policy of the role the effect rules read. */
  readonly policy: Pick<RolePolicy, 'nativeTools' | 'nativeShell' | 'network'>;
}

/** The door of one session: its token and where to hand it to the client. */
export interface McpGrant {
  readonly role: string;
  readonly attemptId: string;
  /**
   * The server as the session receives it: the URL of the daemon and the header
   * `Authorization: Bearer <token>`.
   */
  readonly server: McpServerRef;
  /** Records the session the token belongs to, once the client has opened it. */
  bind(sessionId: string): void;
  /** The session the grant was bound to, if `bind` ran. */
  readonly sessionId: string | undefined;
  /** Ends the token. Idempotent. A later call with it answers 401. */
  revoke(): void;
}

/**
 * What the execution needs of the framework MCP server (architecture 5.3). The runner depends on
 * this interface and not on the server, so tests hand in a double and the daemon hands in the
 * real one.
 */
export interface McpAccess {
  /** `http://127.0.0.1:<port>/mcp`, with the port the server really listens on. */
  readonly url: string;
  grant(input: McpGrantInput): McpGrant;
  /**
   * The names `<id>__<tool>` of the plugin tools the role may call under its policy (P6): the
   * roles of the manifest, then the effects against the policy of the role. The execution puts them
   * in the `mcpTools` of the policy it hands the client, so layers 1 and 2 know them, and in the
   * grant. Absent (a double of a test) or empty: the session has no plugin tool.
   */
  pluginTools?(query: PluginToolsQuery): Promise<readonly string[]>;
}
