// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the `!` command of the Producer (N43, N187; architecture 5.13 and
 * 5.19). Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta]
 * Every payload is a strict object, and neither carries the output of the command: it is in the
 * `terminal_snippet` attachment (the cut one) and in the log of the command (the whole one).
 * The scenario is in the envelope (`scenarioId`).
 */

/** Where the command ran: `app.terminal` (`off` never starts a command). */
export const SHELL_COMMAND_PLACES = ['sandbox', 'host'] as const;

/** Which lines of a long output the snippet keeps (`terminal.snippet.keep`). */
export const SHELL_SNIPPET_KEEPS = ['tail', 'head'] as const;

/** How a `!` command ended. `failed` is a command that could not start. */
export const SHELL_COMMAND_OUTCOMES = ['exited', 'timeout', 'failed'] as const;

/**
 * What became of the output with the Director, from `chat.shell_command.context`: `sent` (it went
 * to the Director as a message with the snippet attached), `asked` (the Producer was asked and the
 * answer decides), `never` (it stays in the chat), `none` (there was no output to send).
 */
export const SHELL_COMMAND_CONTEXTS = ['sent', 'asked', 'never', 'none'] as const;

/** `chat.shell_command.started`: a `!` command began. The command line is what the Producer typed. */
export const ShellCommandStartedPayloadSchema = z.strictObject({
  commandId: z.string().min(1),
  command: z.string().min(1).max(2000),
  place: z.enum(SHELL_COMMAND_PLACES),
});

/**
 * `chat.shell_command.finished`: the command ended. No output here (see the file comment).
 * - `exitCode`: `null` when a signal ended it (the timeout) or it did not start.
 * - `totalLines`, `shownLines`: the lines of the output and the ones the snippet kept
 *   (`terminal.snippet.max_lines`) and from which end (`keep`); `logTruncated` when the log hit `terminal.log_max_size`.
 * - `attachmentId`: the `terminal_snippet` attachment, or `null` when the output was empty.
 * - `askedInput`: the command seems to have waited for input and got the end of the file.
 * - `error`: for `failed`, why it did not start (English, for the log).
 */
export const ShellCommandFinishedPayloadSchema = z.strictObject({
  commandId: z.string().min(1),
  outcome: z.enum(SHELL_COMMAND_OUTCOMES),
  exitCode: z.int().nullable(),
  durationMs: z.int().min(0),
  totalLines: z.int().min(0),
  shownLines: z.int().min(0),
  keep: z.enum(SHELL_SNIPPET_KEEPS),
  logTruncated: z.boolean(),
  attachmentId: z.string().min(1).nullable(),
  askedInput: z.boolean(),
  context: z.enum(SHELL_COMMAND_CONTEXTS),
  logPath: z.string().min(1).nullable(),
  error: z.string().optional(),
});

/**
 * The mark of the question of `chat.shell_command.context: ask` (P26, N205). The daemon puts it in
 * the `input` of the decision (and so in the `input` of the `ask` frame) beside `questions`, so a
 * client knows where the question comes from without reading its options: `source` is
 * {@link SHELL_ASK_SOURCE} and `shell` says what the question is about. Additive: a question of the
 * Director has neither member. [proposta]
 */
export const SHELL_ASK_SOURCE = 'shell';
export const ShellAskMarkSchema = z.strictObject({
  commandId: z.string().min(1),
  /** The command as the Producer typed it, cut at the limit of the events. */
  command: z.string().min(1).max(2000),
  /** `null` when a signal ended the command, or it did not start. */
  exitCode: z.int().nullable(),
  lines: z.int().min(0),
});
export type ShellAskMark = z.infer<typeof ShellAskMarkSchema>;

/** What `input` says about a question of `context: ask`; `undefined` for any other question. */
export function shellAskMarkOf(input: Readonly<Record<string, unknown>>): ShellAskMark | undefined {
  if (input.source !== SHELL_ASK_SOURCE) return undefined;
  const parsed = ShellAskMarkSchema.safeParse(input.shell);
  return parsed.success ? parsed.data : undefined;
}
