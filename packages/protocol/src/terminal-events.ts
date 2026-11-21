// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payload of the `terminal.output` event (Phase 8, P11, N200 item 3): what the terminal of the
 * Actor printed, in blocks. Registered in `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. The
 * payload is a strict object. [proposta] The name and the fields.
 *
 * The daemon builds it from the live output the client sends (`_meta.terminal_output_delta` and
 * `terminal_exit`), masks the shapes of a credential (`maskSecrets`) and cuts it by
 * `events.terminal_output` and `events.terminal_output_max`. The trajectory (`buildTrajectory`)
 * reads `text` and `toolCallId`.
 */

const id = z.string().min(1).max(256);

/** `events.terminal_output`: `on` keeps all of it, `truncated` cuts it at the limit, `off` keeps none. */
export const TERMINAL_OUTPUT_MODES = ['on', 'off', 'truncated'] as const;
export type TerminalOutputMode = (typeof TERMINAL_OUTPUT_MODES)[number];

/** The largest block (bytes of text) one `terminal.output` carries; a longer output is several events. */
export const TERMINAL_BLOCK_BYTES = 16 * 1024;

/**
 * `terminal.output`: one block of the output of terminal `terminalId` of a tool call.
 * - `text`: the block, already masked; empty only for an event that tells the end or the cut.
 * - `truncated`: with `events.terminal_output: truncated`, the limit of the terminal was reached:
 *   this block was cut there, or this event is the closing note of an output that was cut.
 * - `omittedBytes`: how much of the output the cut left out, in bytes (on the closing note it is the
 *   total of the terminal).
 * - `exitCode` and `signal`: set on the last event of a terminal, when the command ended
 *   (`exitCode` is `null` when the client did not say it).
 */
export const TerminalOutputPayloadSchema = z.strictObject({
  sessionId: id,
  terminalId: id,
  toolCallId: id.optional(),
  text: z.string().max(4 * TERMINAL_BLOCK_BYTES),
  truncated: z.boolean().optional(),
  omittedBytes: z.int().min(0).optional(),
  exitCode: z.int().nullable().optional(),
  signal: z.string().min(1).max(64).nullable().optional(),
  playId: id.optional(),
  demandId: id.optional(),
  attemptId: id.optional(),
});
export type TerminalOutputPayload = z.infer<typeof TerminalOutputPayloadSchema>;
