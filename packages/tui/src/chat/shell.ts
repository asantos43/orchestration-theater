// SPDX-License-Identifier: MPL-2.0

/**
 * The `!` command of the Producer on the side of the TUI (P18 of docs/18; N43, N187): what makes a
 * line of the box a command, how the question of `chat.shell_command.context: ask` is told apart
 * from the questions of the Director, and how the output of a command is cleaned to be drawn. Pure.
 * The daemon runs the command and decides everything else (`ShellCommandService`).
 */

/** Whether a line of the box is a `!` command: the first character that is not blank is `!` (as the daemon reads it). */
export function isShellLine(text: string): boolean {
  return text.trimStart().startsWith('!');
}

/** The command of a `!` line: what follows the `!`, with the edges trimmed. */
export function shellCommandOf(text: string): string {
  return text.replace(/^\s*!/u, '').trim();
}

/**
 * The labels of the two options of the question of `chat.shell_command.context: ask`. They are what
 * the daemon compares the answer with (`SEND_LABEL` and `KEEP_LABEL` of `shell/service.ts`), so the
 * card answers with them whatever it shows.
 */
export const SHELL_SEND_LABEL = 'Send';
export const SHELL_KEEP_LABEL = 'Keep';

/** What the question of `context: ask` says about the command it is for. */
export interface ShellAsk {
  readonly command: string;
  /** `null` when a signal ended the command, or it did not start. */
  readonly exitCode: number | null;
  readonly lines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the `input` of a `producer_question` has the shape of the question of `context: ask`: one
 * question with the two options `Send` and `Keep` and nothing else. The ask does not say where it
 * comes from, so the model also waits for the `shell_finished` frame that announced it (`context:
 * 'asked'`) before it takes the question for this one.
 */
export function isShellQuestion(input: Readonly<Record<string, unknown>>): boolean {
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length !== 1) return false;
  const [question] = questions as unknown[];
  if (!isRecord(question) || !Array.isArray(question.options)) return false;
  const labels = (question.options as unknown[]).map((option) =>
    isRecord(option) ? option.label : undefined,
  );
  return labels.length === 2 && labels[0] === SHELL_SEND_LABEL && labels[1] === SHELL_KEEP_LABEL;
}

/** The longest command the screen repeats (the state line, the question). */
export const SHELL_COMMAND_SHOWN = 60;

/** `text` on one line, cut with an ellipsis past `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// eslint-disable-next-line no-control-regex -- the escape character is what the sequences start with
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./gu;
// eslint-disable-next-line no-control-regex -- every control character but the tab goes
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * The lines of the snippet as the screen may draw them: the daemon already took the colours and the
 * redrawn lines out, but what a program prints is not trusted with the terminal of the Producer, so
 * what is left of the escape sequences and of the control characters goes too, and a tab becomes
 * spaces.
 */
export function outputLines(snippet: string): string[] {
  if (snippet === '') return [];
  const lines = snippet
    .replaceAll(ESCAPES, '')
    .replaceAll(CONTROLS, '')
    .split('\n')
    .map((line) => line.replaceAll('\t', '    ').trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
