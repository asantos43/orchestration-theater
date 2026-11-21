// SPDX-License-Identifier: MPL-2.0
import type { NormalizedUpdate } from './normalized-update.js';

/**
 * The live output of the terminal of an Actor, as the client sends it (Phase 8, P11, N200 item 3).
 * The OTheater client declares `_meta.terminal_output_delta` in `initialize`, and a client that
 * knows the convention answers with, in the `_meta` of a `tool_call` or `tool_call_update`:
 * `terminal_info: { terminal_id }`, `terminal_output_delta: { terminal_id, data }` (or the older
 * `terminal_output` with the same shape) and `terminal_exit: { terminal_id, exit_code, signal }`.
 * [V, reading `claude-agent-acp` 0.107.0, 2026-11-21] The Claude adapter does it; Codex and OpenCode
 * are [N], to measure. The command keeps running inside the official client: this only shows it.
 *
 * This reads the raw update of the session, whatever the client, and gives the `terminal_output`
 * update. It never throws: a shape it does not know gives `undefined`.
 */
export function terminalUpdateOf(raw: unknown): NormalizedUpdate | undefined {
  const update = record(raw);
  const meta = record(update?._meta);
  if (update === undefined || meta === undefined) return undefined;
  const toolCallId = text(update.toolCallId);
  const output = record(meta.terminal_output_delta) ?? record(meta.terminal_output);
  const exit = record(meta.terminal_exit);
  const terminalId =
    text(output?.terminal_id) ??
    text(exit?.terminal_id) ??
    text(record(meta.terminal_info)?.terminal_id);
  if (terminalId === undefined) return undefined;
  const data = typeof output?.data === 'string' && output.data !== '' ? output.data : undefined;
  const code = exit?.exit_code;
  const signal = exit?.signal;
  const ended =
    exit === undefined
      ? undefined
      : {
          code: typeof code === 'number' && Number.isInteger(code) ? code : null,
          signal: text(signal) ?? null,
        };
  if (data === undefined && ended === undefined) return undefined;
  return {
    kind: 'terminal_output',
    terminalId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(data === undefined ? {} : { text: data }),
    ...(ended === undefined ? {} : { exit: ended }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= 256 ? value : undefined;
}
