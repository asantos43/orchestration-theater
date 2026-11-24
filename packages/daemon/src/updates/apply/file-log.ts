// SPDX-License-Identifier: MPL-2.0
import { appendFileSync } from 'node:fs';
import type { Logger } from '../../logger.js';

/** What an error leaves in a log line: `JSON.stringify` of an `Error` is `{}`, which says nothing. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as NodeJS.ErrnoException).code;
    const syscall = (value as NodeJS.ErrnoException).syscall;
    return {
      name: value.name,
      message: value.message,
      ...(code === undefined ? {} : { code }),
      ...(syscall === undefined ? {} : { syscall }),
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  return value;
}

/**
 * A logger that appends to a file, one JSON line per call, written synchronously: the applier has no
 * terminal to write to, it may be killed at any moment, and a line that is still in a buffer then is
 * the line that would have said where it stopped (Phase 10, P12). A failed write is dropped: nothing
 * can be told about it. `err` and `error` fields that are errors are written with their code and stack.
 */
export function appendFileLogger(file: string): Pick<Logger, 'info' | 'warn' | 'error'> {
  const write =
    (level: string) =>
    (fields: unknown, message?: string): void => {
      try {
        const text = typeof fields === 'string' ? fields : (message ?? '');
        const extra: Record<string, unknown> = {};
        if (typeof fields === 'object' && fields !== null) {
          for (const [key, value] of Object.entries(fields)) extra[key] = plain(value);
        }
        appendFileSync(
          file,
          `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, level, msg: text, ...extra })}\n`,
        );
      } catch {
        // Nothing to tell it to.
      }
    };
  return { info: write('info'), warn: write('warn'), error: write('error') } as Pick<
    Logger,
    'info' | 'warn' | 'error'
  >;
}
