// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent } from './events.js';
import {
  ShellCommandFinishedPayloadSchema,
  ShellCommandStartedPayloadSchema,
  shellAskMarkOf,
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

describe('the mark of the question of context: ask (N205)', () => {
  const shell = { commandId: 'sh_1', command: 'ls', exitCode: 0, lines: 3 };

  it('is read from source and shell of the input of the question', () => {
    expect(shellAskMarkOf({ questions: [], source: 'shell', shell })).toEqual(shell);
    expect(shellAskMarkOf({ source: 'shell', shell: { ...shell, exitCode: null } })).toMatchObject({
      exitCode: null,
    });
  });

  it('is nothing for a question of the Director, or a mark that does not fit', () => {
    expect(shellAskMarkOf({ questions: [] })).toBeUndefined();
    expect(shellAskMarkOf({ source: 'browser', shell })).toBeUndefined();
    expect(shellAskMarkOf({ source: 'shell' })).toBeUndefined();
    expect(shellAskMarkOf({ source: 'shell', shell: { command: 'ls' } })).toBeUndefined();
  });
});
