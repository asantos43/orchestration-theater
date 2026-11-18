// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { MAX_TRACKED_TOOL_CALLS, ToolCallState } from './tool-call-state.js';

const call = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  status: 'pending',
  ...extra,
});

describe('ToolCallState', () => {
  it('keeps the title, kind, rawInput and _meta of a tool_call', () => {
    const state = new ToolCallState();
    state.record(
      call('a', {
        title: 't',
        kind: 'execute',
        rawInput: { x: 1 },
        _meta: { is_mcp_tool_call: true },
      }),
    );
    expect(state.get('a')).toEqual({
      title: 't',
      kind: 'execute',
      rawInput: { x: 1 },
      meta: { is_mcp_tool_call: true },
    });
  });

  it('an update overwrites only the fields it carries, and merges _meta key by key', () => {
    const state = new ToolCallState();
    state.record(
      call('a', { title: 't', kind: 'execute', rawInput: { x: 1 }, _meta: { a: 1, b: 2 } }),
    );
    state.record({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'in_progress',
      title: 'u',
      rawInput: null,
      _meta: { b: 3 },
    });
    expect(state.get('a')).toEqual({
      title: 'u',
      kind: 'execute',
      rawInput: { x: 1 },
      meta: { a: 1, b: 3 },
    });
  });

  it('forgets a call that completed or failed', () => {
    const state = new ToolCallState();
    state.record(call('a'));
    state.record(call('b'));
    expect(state.size).toBe(2);
    state.record({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' });
    state.record({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed' });
    expect(state.size).toBe(0);
    expect(state.get('a')).toBeUndefined();
  });

  it('ignores other updates, junk, and a call with no id', () => {
    const state = new ToolCallState();
    state.record({ sessionUpdate: 'agent_message_chunk', toolCallId: 'a' });
    state.record(null);
    state.record('tool_call');
    state.record(call(''));
    state.record({ sessionUpdate: 'tool_call' });
    expect(state.size).toBe(0);
  });

  it('never holds more than the limit and drops the least recent first', () => {
    const state = new ToolCallState(3);
    for (const id of ['a', 'b', 'c']) state.record(call(id, { title: id }));
    state.record({ sessionUpdate: 'tool_call_update', toolCallId: 'a', title: 'a2' });
    state.record(call('d', { title: 'd' }));
    expect(state.size).toBe(3);
    expect(state.get('b')).toBeUndefined();
    expect(state.get('a')?.title).toBe('a2');
    expect(state.get('d')?.title).toBe('d');
  });

  it('has a limit of 1024 by default', () => {
    const state = new ToolCallState();
    for (let i = 0; i < MAX_TRACKED_TOOL_CALLS + 50; i += 1) state.record(call(`c${String(i)}`));
    expect(state.size).toBe(MAX_TRACKED_TOOL_CALLS);
    expect(state.get('c0')).toBeUndefined();
    expect(state.get(`c${String(MAX_TRACKED_TOOL_CALLS + 49)}`)).toBeDefined();
  });
});
