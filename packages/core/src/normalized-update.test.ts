// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ContentBlockSchema,
  NORMALIZED_UPDATE_KINDS,
  NormalizedUpdateSchema,
  STOP_REASONS,
  StopReasonSchema,
  type NormalizedUpdate,
} from './normalized-update.js';

const good: Record<(typeof NORMALIZED_UPDATE_KINDS)[number], unknown> = {
  agent_message_chunk: { kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
  agent_thought_chunk: {
    kind: 'agent_thought_chunk',
    content: { type: 'text', text: '...' },
    messageId: 'm1',
  },
  tool_call: {
    kind: 'tool_call',
    toolCallId: 't1',
    title: 'Read file',
    toolKind: 'read',
    status: 'pending',
    locations: [{ path: '/work/a.ts', line: 3 }],
  },
  tool_call_update: { kind: 'tool_call_update', toolCallId: 't1', status: 'completed' },
  plan: {
    kind: 'plan',
    entries: [{ content: 'do it', priority: 'high', status: 'in_progress' }],
  },
  usage: { kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  available_commands: {
    kind: 'available_commands',
    commands: [{ name: 'compact', description: 'Compact the context' }],
  },
  config_changed: {
    kind: 'config_changed',
    options: [{ id: 'mode', category: 'mode', value: 'plan' }],
  },
  rate_limit: { kind: 'rate_limit', status: 'warning', window: 'five_hour', usedPercent: 91 },
  terminal_output: {
    kind: 'terminal_output',
    terminalId: 'toolu_1',
    toolCallId: 'toolu_1',
    text: 'ok\n',
    exit: { code: 0, signal: null },
  },
};

describe('NormalizedUpdateSchema', () => {
  it('has a good example for every kind', () => {
    expect(Object.keys(good).sort()).toEqual([...NORMALIZED_UPDATE_KINDS].sort());
    for (const [kind, value] of Object.entries(good)) {
      expect(NormalizedUpdateSchema.safeParse(value).success, kind).toBe(true);
    }
  });

  it('refuses an unknown kind, an unknown field and a wrong type', () => {
    const bad: unknown[] = [
      { kind: 'other' },
      { ...(good.plan as object), extra: 1 },
      { kind: 'tool_call', toolCallId: 't1', title: 'x', toolKind: 'nope', status: 'pending' },
      { kind: 'tool_call', toolCallId: 't1', title: 'x', toolKind: 'read', status: 'done' },
      { kind: 'tool_call_update', toolCallId: '' },
      { kind: 'agent_message_chunk', content: { type: 'text' } },
      { kind: 'usage', inputTokens: -1 },
      { kind: 'terminal_output', terminalId: 't1' },
      { kind: 'terminal_output', terminalId: 't1', text: '' },
      { kind: 'usage', inputTokens: 1.5 },
      { kind: 'config_changed', options: [] },
      { kind: 'rate_limit', status: 'blocked' },
    ];
    for (const value of bad) {
      expect(NormalizedUpdateSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('needs at least one numeric field in a usage update', () => {
    expect(NormalizedUpdateSchema.safeParse({ kind: 'usage' }).success).toBe(false);
    expect(NormalizedUpdateSchema.safeParse({ kind: 'usage', model: 'm' }).success).toBe(false);
    expect(NormalizedUpdateSchema.safeParse({ kind: 'usage', contextUsed: 0 }).success).toBe(true);
  });

  it('narrows by kind', () => {
    const update: NormalizedUpdate = NormalizedUpdateSchema.parse(good.tool_call);
    if (update.kind === 'tool_call') {
      expect(update.toolKind).toBe('read');
    } else {
      expect.unreachable();
    }
  });
});

describe('ContentBlockSchema', () => {
  it('accepts the five block types', () => {
    const blocks: unknown[] = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
      { type: 'resource', resource: { uri: 'file:///a', text: 'x' } },
      { type: 'resource', resource: { uri: 'file:///a', blob: 'AAAA' } },
    ];
    for (const block of blocks) {
      expect(ContentBlockSchema.safeParse(block).success, JSON.stringify(block)).toBe(true);
    }
  });

  it('refuses a block without its payload', () => {
    expect(ContentBlockSchema.safeParse({ type: 'image', data: 'AAAA' }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ type: 'resource', resource: { uri: 'x' } }).success).toBe(
      false,
    );
  });
});

describe('StopReasonSchema', () => {
  it('lists the five ACP stop reasons', () => {
    expect([...STOP_REASONS]).toEqual([
      'end_turn',
      'max_tokens',
      'max_turn_requests',
      'refusal',
      'cancelled',
    ]);
    expect(StopReasonSchema.safeParse('refusal').success).toBe(true);
    expect(StopReasonSchema.safeParse('stop').success).toBe(false);
  });
});
