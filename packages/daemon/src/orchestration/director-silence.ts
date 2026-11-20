// SPDX-License-Identifier: MPL-2.0
import type { ChatToolCall } from '@otheater/protocol';
import type { NormalizedUpdate } from '@otheater/core';

/**
 * A turn of the Director that ends with no text (N183, decision of the owner of 2026-11-20). The
 * session reports the tool calls of the turn as ACP `tool_call` and `tool_call_update` updates, in
 * the same `onUpdate` that carries the text; this module keeps them, and writes the line the daemon
 * says for the Director when `chat.silent_turn` is `notice`.
 */

/** The longest name of a tool kept (the title the client reports can be a whole command line). */
const TOOL_NAME_MAX = 80;

/** What the notice says when the client gave a tool call no title. */
const UNNAMED_TOOL = 'tool';

/** One tool call of a turn, as the updates report it. */
interface TurnTool {
  name: string;
  status: ChatToolCall['status'];
}

/**
 * The tool calls of one turn of the Director, from its updates. A `tool_call` starts one and a
 * `tool_call_update` of the same `toolCallId` changes its title or status; they stay in the order
 * they started. An update of a call nobody started still counts (a client may report only the end).
 */
export class TurnTools {
  readonly #calls = new Map<string, TurnTool>();

  /** Takes the tool update of `update`, if it is one. */
  note(update: NormalizedUpdate): void {
    if (update.kind !== 'tool_call' && update.kind !== 'tool_call_update') return;
    const title = update.title === undefined ? '' : nameOf(update.title);
    const known = this.#calls.get(update.toolCallId);
    if (known === undefined) {
      this.#calls.set(update.toolCallId, {
        name: title === '' ? UNNAMED_TOOL : title,
        status: update.status ?? null,
      });
      return;
    }
    if (title !== '') known.name = title;
    if (update.status !== undefined) known.status = update.status;
  }

  /** The calls so far, in the order they started. */
  list(): ChatToolCall[] {
    return [...this.#calls.values()].map(({ name, status }) => ({ name, status }));
  }
}

function nameOf(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_NAME_MAX ? `${flat.slice(0, TOOL_NAME_MAX - 1)}…` : flat;
}

/**
 * The line the daemon keeps as the reply of a silent turn, in English (events stay in English; the
 * `ot chat` client says it in the language of the Producer from `tools` and `playId`, like the
 * other system messages). Deterministic: the same tools and play always give the same text.
 */
export function silentReplyText(tools: readonly ChatToolCall[], playId: string | null): string {
  const lead = 'The Director ended the turn without a reply.';
  if (tools.length === 0) return lead;
  const called = tools
    .map((tool) => (tool.status === 'failed' ? `${tool.name} (failed)` : tool.name))
    .join(', ');
  return `${lead} Tools called: ${called}.${playId === null ? '' : ` Play opened: ${playId}.`}`;
}
