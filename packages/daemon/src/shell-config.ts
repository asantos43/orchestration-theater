// SPDX-License-Identifier: MPL-2.0

/**
 * The keys of the `!` command of the Producer (N43, N187; architecture 5.13 and 5.19). [proposta]
 * the names and defaults, but `app.terminal`'s modes and `terminal.snippet.max_lines`' default come
 * from the architecture.
 *
 * - `app.terminal`: how the `!` command runs. `sandbox` (default): inside the sandbox of layer 3,
 *   and if none is available the command is refused, never run unconfined; `host`: as the daemon's
 *   own user, with no confinement (the Producer chose it); `off`: no `!` command.
 * - `terminal.snippet.max_lines` (default 200): how many lines of the output enter the snippet.
 *   `terminal.snippet.keep` (default `tail`) says which lines stay when the output is longer:
 *   `tail` the last ones, `head` the first ones. The whole output
 *   stays in the log of the command. `terminal.log_max_size` (default 16MB) caps that log; past it
 *   the log stops growing and says so.
 */
export const APP_TERMINAL_MODES = ['sandbox', 'host', 'off'] as const;
export type AppTerminalMode = (typeof APP_TERMINAL_MODES)[number];

export const SNIPPET_KEEP_MODES = ['tail', 'head'] as const;
export type SnippetKeepMode = (typeof SNIPPET_KEEP_MODES)[number];

/** `chat.shell_command.context`: whether the output of a `!` command enters the Director's conversation. */
export const SHELL_CONTEXT_MODES = ['auto', 'ask', 'never'] as const;
export type ShellContextMode = (typeof SHELL_CONTEXT_MODES)[number];

export const SHELL_COMMAND_MODES = ['on', 'off'] as const;
export type ShellCommandMode = (typeof SHELL_COMMAND_MODES)[number];

/** Default of `chat.shell_command.timeout` (owner's choice of 2026-11-20): 5 minutes. */
export const SHELL_TIMEOUT_DEFAULT = '5m';

/** The `chat.shell_command` section once parsed; `timeout` is milliseconds, `null` for `off`. */
export interface ShellCommandConfig {
  readonly mode: ShellCommandMode;
  readonly timeout: number | null;
  readonly context: ShellContextMode;
  /** How many commands of one scenario may run at once. */
  readonly max_running: number;
}

/** The `terminal` section once parsed (sizes in bytes). */
export interface TerminalConfig {
  readonly snippet: { readonly max_lines: number; readonly keep: SnippetKeepMode };
  readonly log_max_size: number;
}
