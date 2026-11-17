// SPDX-License-Identifier: MPL-2.0
import type { McpServerRef, NewEvent } from '@otheater/core';

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
  readonly correlation: McpCorrelation;
  /**
   * Appends an event of this attempt to the log (the journal of the attempt). The `submit*` tools
   * write `attempt.submitted` and `attempt.submit_failed` through it.
   */
  readonly record: (event: NewEvent) => Promise<void>;
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
}
