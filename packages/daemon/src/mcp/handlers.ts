// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, type NewEvent, type ToolDefinition } from '@otheater/core';
import type { McpCorrelation } from './access.js';

/** Who is calling: the session of one attempt, with the role its token was minted for. */
export interface ToolCaller {
  readonly role: string;
  readonly attemptId: string;
  readonly sessionId: string | undefined;
  readonly correlation: McpCorrelation;
  /** The worktree of the attempt, when the grant carries one (see `McpGrantInput.worktree`). */
  readonly worktree?: string | undefined;
  /** The domains the role may reach with `http_get` (`McpGrantInput.networkAllow`). */
  readonly networkAllow?: readonly string[];
  /** Appends an event of the attempt to the log. */
  readonly record: (event: NewEvent) => Promise<void>;
  /**
   * Aborts when the client gives up on this call (the MCP request is cancelled or its connection
   * closes). A handler that waits (`ask_director`, P15 of Phase 11b) stops waiting on it.
   */
  readonly signal?: AbortSignal | undefined;
}

/** One call of a tool, already validated against its schema and allowed for the role. */
export interface ToolCall {
  readonly tool: ToolDefinition;
  readonly input: unknown;
  readonly caller: ToolCaller;
}

/**
 * Runs a tool and returns its result (any JSON value). A throw is an error result for the client;
 * the server logs it. Returned objects go back as `structuredContent` and as text.
 */
export type ToolHandler = (call: ToolCall) => unknown;

/**
 * The handlers of the tools of the registry, by name (architecture 5.3). The server registers the
 * tools of the role from the tool registry; what runs when one is called is looked up here.
 * `submit*` is built in (`runSubmit`); the other tools get their handler from the step that owns
 * them: the blackboard and contracts (P7), the orders (P10) and the chat (P12). A tool without a
 * handler answers a structured error that says so (see `notImplemented`).
 */
export class ToolHandlers {
  readonly #byName = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): this {
    if (this.#byName.has(name)) {
      throw new InvalidInput(`a handler for the tool "${name}" is already registered`);
    }
    this.#byName.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.#byName.get(name);
  }
}

/**
 * [proposta] What a handler throws or returns when the call is refused for a reason the Executor
 * can act on (an unknown order, a conflict, a bad date, a miss such as `not_found`): the server
 * answers an error result carrying `error` (a stable code) and the message, instead of the opaque
 * `internal_error` of an unexpected throw.
 */
export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Extra fields of the error result (the order a draft conflicts with, say). */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/**
 * [proposta] A reply that carries an image (a screenshot of `browser_screenshot`): `value` goes
 * back as `structuredContent` and as text, like any reply, and `image` as an `image` content block
 * the model can look at. `data` is base64 (what the MCP image block takes).
 */
export class ToolWithImage {
  constructor(
    readonly value: unknown,
    readonly image: { readonly mimeType: string; readonly data: string },
  ) {}
}

/**
 * [proposta] What a registered tool with no handler yet answers: an error result with a stable
 * `error` code, so an Executor (and a test) can tell "not built yet" from a failure of the tool.
 */
export function notImplemented(tool: string): { readonly error: string; readonly message: string } {
  return {
    error: 'not_implemented',
    message: `The tool "${tool}" exists in the registry but has no handler in this version of the daemon.`,
  };
}
