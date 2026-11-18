// SPDX-License-Identifier: MPL-2.0

/**
 * What the transport remembers about a tool call of a session between its `tool_call` and the
 * `session/request_permission` that asks about it. Codex ([V] codex-acp 2.6.0, 2026-11-17) puts the
 * name of an MCP tool only in the `tool_call` (`title`, `rawInput`, `_meta`); the request that
 * follows repeats the `toolCallId` and the `kind` and nothing else. Under ACP the `toolCall` of the
 * request is a ToolCallUpdate: a field it leaves out has not changed since the last message about
 * that id, so the transport has to keep what it saw.
 */
export interface ToolCallFields {
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  /** The `_meta` of the tool call, merged key by key as the updates bring them. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** The most tool calls one session remembers; past it the oldest are forgotten. */
export const MAX_TRACKED_TOOL_CALLS = 1024;

const FINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The tool calls of one session, newest last. Bounded twice so a long session does not leak: an
 * entry goes away when its call ends (`completed` or `failed`), and the table never holds more than
 * {@link MAX_TRACKED_TOOL_CALLS} entries.
 */
export class ToolCallState {
  readonly #calls = new Map<string, ToolCallFields>();
  readonly #limit: number;

  constructor(limit: number = MAX_TRACKED_TOOL_CALLS) {
    this.#limit = limit;
  }

  /** How many calls are remembered. */
  get size(): number {
    return this.#calls.size;
  }

  /** What is known about the call, or `undefined`. */
  get(toolCallId: string): ToolCallFields | undefined {
    return this.#calls.get(toolCallId);
  }

  /**
   * Takes in a raw `session/update`: only `tool_call` and `tool_call_update` matter, and an update
   * overwrites just the fields it carries. A call that reports `completed` or `failed` is forgotten.
   */
  record(update: unknown): void {
    if (!isRecord(update)) return;
    const { sessionUpdate, toolCallId } = update;
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return;
    if (typeof toolCallId !== 'string' || toolCallId === '') return;
    if (typeof update.status === 'string' && FINAL_STATUSES.has(update.status)) {
      this.#calls.delete(toolCallId);
      return;
    }
    const before = this.#calls.get(toolCallId);
    const meta = isRecord(update._meta) ? { ...before?.meta, ...update._meta } : before?.meta;
    const title = typeof update.title === 'string' ? update.title : before?.title;
    const kind = typeof update.kind === 'string' ? update.kind : before?.kind;
    const rawInput = update.rawInput ?? before?.rawInput;
    const next: ToolCallFields = {
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(rawInput === undefined ? {} : { rawInput }),
      ...(meta === undefined ? {} : { meta }),
    };
    // Re-inserted, so the newest is last and the one dropped at the limit is the least recent.
    this.#calls.delete(toolCallId);
    this.#calls.set(toolCallId, next);
    while (this.#calls.size > this.#limit) {
      const oldest = this.#calls.keys().next();
      if (oldest.done === true) break;
      this.#calls.delete(oldest.value);
    }
  }
}
