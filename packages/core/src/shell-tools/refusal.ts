// SPDX-License-Identifier: MPL-2.0
import { PermissionDenied } from '../errors.js';

/**
 * Why a shell tool call was refused before anything ran (architecture 5.8, layer 2 "cascas"). The
 * handler turns the reason into the error code the Executor sees, so the model can tell a path
 * that escapes the worktree from a program that is not on the list.
 */
export const SHELL_REFUSAL_REASONS = [
  'empty_argv',
  'invalid_argument',
  'program_by_path',
  'program_not_allowed',
  'shell_syntax',
  'forbidden_flag',
  'path_escapes',
  'symlink_escapes',
  'invalid_path',
] as const;
export type ShellRefusalReason = (typeof SHELL_REFUSAL_REASONS)[number];

/** A shell tool call refused by the argv or the confinement rules. Retrying it unchanged is futile. */
export class ShellToolRefusal extends PermissionDenied {
  readonly reason: ShellRefusalReason;

  constructor(reason: ShellRefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}
