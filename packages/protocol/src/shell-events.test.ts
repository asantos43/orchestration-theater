// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent } from './events.js';
import {
  ShellCommandFinishedPayloadSchema,
  ShellCommandStartedPayloadSchema,
} from './shell-events.js';

const finished = {
  commandId: 'sh_1',
  outcome: 'exited',
  exitCode: 0,
  durationMs: 12,
  totalLines: 3,
  shownLines: 3,
  keep: 'tail',
  logTruncated: false,
  attachmentId: 'A1',
  askedInput: false,
  context: 'sent',
  logPath: '/data/scenarios/s/terminal/sh_1.log',
} as const;

describe('the events of the ! command (N43, N187)', () => {
  it('started names the command and where it ran, and is strict', () => {
    const started = { commandId: 'sh_1', command: 'ls -la', place: 'sandbox' };
    expect(ShellCommandStartedPayloadSchema.parse(started)).toEqual(started);
    expect(ShellCommandStartedPayloadSchema.safeParse({ ...started, place: 'off' }).success).toBe(
      false,
    );
    expect(ShellCommandStartedPayloadSchema.safeParse({ ...started, extra: 1 }).success).toBe(
      false,
    );
  });

  it('finished carries the exit code and never the output', () => {
    expect(ShellCommandFinishedPayloadSchema.parse(finished)).toEqual(finished);
    expect(ShellCommandFinishedPayloadSchema.safeParse({ ...finished, output: 'x' }).success).toBe(
      false,
    );
    expect(ShellCommandFinishedPayloadSchema.safeParse({ ...finished, snippet: 'x' }).success).toBe(
      false,
    );
    expect(
      ShellCommandFinishedPayloadSchema.parse({
        ...finished,
        outcome: 'timeout',
        exitCode: null,
        attachmentId: null,
      }).exitCode,
    ).toBeNull();
  });

  it('both are registered events of a scenario', () => {
    const event = buildDaemonEvent('chat.shell_command.finished', {
      ...finished,
      outcome: 'exited',
      context: 'sent',
    });
    expect(event.type).toBe('chat.shell_command.finished');
    expect(event.schemaVersion).toBe(1);
  });
});
