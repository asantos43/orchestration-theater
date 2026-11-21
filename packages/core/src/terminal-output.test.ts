// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { NormalizedUpdateSchema } from './normalized-update.js';
import { terminalUpdateOf } from './terminal-output.js';

describe('terminalUpdateOf', () => {
  it('reads the output delta of a tool call update', () => {
    const update = terminalUpdateOf({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      _meta: { terminal_output_delta: { terminal_id: 'toolu_1', data: 'hello\n' } },
    });
    expect(update).toEqual({
      kind: 'terminal_output',
      terminalId: 'toolu_1',
      toolCallId: 'toolu_1',
      text: 'hello\n',
    });
    expect(NormalizedUpdateSchema.safeParse(update).success).toBe(true);
  });

  it('reads the older terminal_output and the exit of the same update', () => {
    expect(
      terminalUpdateOf({
        toolCallId: 'toolu_2',
        _meta: {
          terminal_info: { terminal_id: 'toolu_2' },
          terminal_output: { terminal_id: 'toolu_2', data: 'x' },
          terminal_exit: { terminal_id: 'toolu_2', exit_code: 2, signal: null },
        },
      }),
    ).toEqual({
      kind: 'terminal_output',
      terminalId: 'toolu_2',
      toolCallId: 'toolu_2',
      text: 'x',
      exit: { code: 2, signal: null },
    });
  });

  it('reads an exit with no output, and keeps a missing code as null', () => {
    expect(
      terminalUpdateOf({
        _meta: { terminal_exit: { terminal_id: 't', exit_code: null, signal: 'SIGKILL' } },
      }),
    ).toEqual({
      kind: 'terminal_output',
      terminalId: 't',
      exit: { code: null, signal: 'SIGKILL' },
    });
  });

  it('gives nothing for a message with no terminal, an empty one or a shape it does not know', () => {
    expect(terminalUpdateOf(undefined)).toBeUndefined();
    expect(terminalUpdateOf('text')).toBeUndefined();
    expect(terminalUpdateOf({ sessionUpdate: 'plan', entries: [] })).toBeUndefined();
    // the start of a terminal (`terminal_info` alone) carries no output
    expect(
      terminalUpdateOf({ toolCallId: 't', _meta: { terminal_info: { terminal_id: 't' } } }),
    ).toBeUndefined();
    expect(
      terminalUpdateOf({ _meta: { terminal_output_delta: { terminal_id: 't', data: '' } } }),
    ).toBeUndefined();
    expect(
      terminalUpdateOf({ _meta: { terminal_output_delta: { terminal_id: 7, data: 'x' } } }),
    ).toBeUndefined();
  });
});
