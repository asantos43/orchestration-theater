// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent } from './events.js';
import {
  TERMINAL_BLOCK_BYTES,
  TERMINAL_OUTPUT_MODES,
  TerminalOutputPayloadSchema,
} from './terminal-events.js';

describe('terminal.output', () => {
  it('accepts a block with the correlation of the attempt', () => {
    const payload = {
      sessionId: 's1',
      terminalId: 'toolu_1',
      toolCallId: 'toolu_1',
      text: 'ok\n',
      playId: 'p1',
      demandId: 'd1',
      attemptId: 'a1',
    };
    expect(TerminalOutputPayloadSchema.parse(payload)).toEqual(payload);
    expect(buildDaemonEvent('terminal.output', payload).type).toBe('terminal.output');
  });

  it('accepts the cut and the exit, and an empty text for the closing note', () => {
    const payload = {
      sessionId: 's1',
      terminalId: 't',
      text: '',
      truncated: true,
      omittedBytes: 900,
      exitCode: null,
      signal: 'SIGKILL',
    };
    expect(TerminalOutputPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('refuses an unknown field, a negative size and a text past four blocks', () => {
    const base = { sessionId: 's1', terminalId: 't', text: 'x' };
    expect(TerminalOutputPayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(TerminalOutputPayloadSchema.safeParse({ ...base, omittedBytes: -1 }).success).toBe(
      false,
    );
    expect(
      TerminalOutputPayloadSchema.safeParse({
        ...base,
        text: 'x'.repeat(4 * TERMINAL_BLOCK_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(TerminalOutputPayloadSchema.safeParse({ sessionId: 's1', text: 'x' }).success).toBe(
      false,
    );
  });

  it('has the three modes', () => {
    expect([...TERMINAL_OUTPUT_MODES]).toEqual(['on', 'off', 'truncated']);
  });
});
