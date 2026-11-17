// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { ToolCalledPayloadSchema, ToolFinishedPayloadSchema } from './tool-events.js';
import { buildDaemonEvent } from './events.js';

describe('tool events', () => {
  it('accepts tool.called with the correlation of the attempt', () => {
    const payload = {
      tool: 'restricted_shell',
      role: 'actor',
      callId: 'call-1',
      summary: 'git status --short',
      heavy: false,
      playId: 'p1',
      demandId: 'd1',
      attemptId: 'a1',
    };
    expect(ToolCalledPayloadSchema.parse(payload)).toEqual(payload);
    expect(buildDaemonEvent('tool.called', payload).type).toBe('tool.called');
  });

  it('accepts tool.finished for every outcome, with and without the optional fields', () => {
    for (const outcome of ['ok', 'failed', 'refused', 'timed_out', 'error'] as const) {
      const payload = {
        tool: 'run_tests',
        role: 'actor',
        callId: 'call-2',
        outcome,
        durationMs: 12,
        queuedMs: 0,
      };
      expect(ToolFinishedPayloadSchema.parse(payload)).toEqual(payload);
    }
    const full = {
      tool: 'run_tests',
      role: 'actor',
      callId: 'call-2',
      outcome: 'failed',
      exitCode: 1,
      errorCode: 'x',
      durationMs: 5,
      queuedMs: 3,
      outputBytes: 100,
      truncated: true,
    };
    expect(ToolFinishedPayloadSchema.parse(full)).toEqual(full);
    expect(ToolFinishedPayloadSchema.parse({ ...full, exitCode: null }).exitCode).toBeNull();
  });

  it('refuses an unknown field, a bad outcome and a long summary', () => {
    const called = { tool: 't', role: 'r', callId: 'c', summary: '', heavy: true };
    expect(ToolCalledPayloadSchema.safeParse({ ...called, stdout: 'x' }).success).toBe(false);
    expect(ToolCalledPayloadSchema.safeParse({ ...called, summary: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(
      ToolFinishedPayloadSchema.safeParse({
        tool: 't',
        role: 'r',
        callId: 'c',
        outcome: 'weird',
        durationMs: 0,
        queuedMs: 0,
      }).success,
    ).toBe(false);
  });
});
