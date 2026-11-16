// SPDX-License-Identifier: MPL-2.0
import type { NormalizedUpdate } from '@otheater/core';

/**
 * Hand-made `session/update` payloads of `claude-agent-acp` (ACP v1 shapes), not captured from a
 * run: Phase 0 kept no raw log with these fields. The field names and the `_claude/rateLimit`
 * structure follow `spikes/acp-claude/README.md` (items 3 and 9) [V]; the values are invented.
 * The `claudeCode.toolName` key of `_meta` comes from reading the adapter [N].
 */
export interface UpdateFixture {
  readonly name: string;
  readonly raw: unknown;
  /** `null`: the shell swallows it. */
  readonly expected: NormalizedUpdate | null;
}

export const UPDATE_FIXTURES: readonly UpdateFixture[] = [
  {
    name: 'a text message chunk',
    raw: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    expected: { kind: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  },
  {
    name: 'a thought chunk with a message id',
    raw: {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'm-1',
      content: { type: 'text', text: 'thinking' },
    },
    expected: {
      kind: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
      messageId: 'm-1',
    },
  },
  {
    name: 'an image chunk',
    raw: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    },
    expected: {
      kind: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    },
  },
  {
    name: 'a chunk of a content type this adapter does not carry',
    raw: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'resource_link', uri: 'file:///x', name: 'x' },
    },
    expected: null,
  },
  {
    name: 'a tool call with locations',
    raw: {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_01',
      title: 'Read src/a.ts',
      kind: 'read',
      status: 'pending',
      locations: [{ path: '/work/src/a.ts', line: 1 }, { path: '/work/src/b.ts' }],
    },
    expected: {
      kind: 'tool_call',
      toolCallId: 'toolu_01',
      title: 'Read src/a.ts',
      toolKind: 'read',
      status: 'pending',
      locations: [{ path: '/work/src/a.ts', line: 1 }, { path: '/work/src/b.ts' }],
    },
  },
  {
    name: 'a tool call whose kind is missing, with the tool name in _meta',
    raw: {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_02',
      title: 'Terminal',
      status: 'in_progress',
      _meta: { claudeCode: { toolName: 'Bash' } },
    },
    expected: {
      kind: 'tool_call',
      toolCallId: 'toolu_02',
      title: 'Terminal',
      toolKind: 'execute',
      status: 'in_progress',
    },
  },
  {
    name: 'a tool call of an unknown kind and tool',
    raw: {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_03',
      title: 'Something new',
      kind: 'teleport',
      status: 'pending',
    },
    expected: {
      kind: 'tool_call',
      toolCallId: 'toolu_03',
      title: 'Something new',
      toolKind: 'other',
      status: 'pending',
    },
  },
  {
    name: 'a tool call update that only changes the status',
    raw: { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed' },
    expected: { kind: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed' },
  },
  {
    name: 'a plan',
    raw: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'read the code', priority: 'high', status: 'completed' },
        { content: 'write the test', priority: 'medium', status: 'in_progress' },
      ],
    },
    expected: {
      kind: 'plan',
      entries: [
        { content: 'read the code', priority: 'high', status: 'completed' },
        { content: 'write the test', priority: 'medium', status: 'in_progress' },
      ],
    },
  },
  {
    name: 'a plan with an entry of an unknown status',
    raw: {
      sessionUpdate: 'plan',
      entries: [{ content: 'x', priority: 'high', status: 'blocked' }],
    },
    expected: null,
  },
  {
    name: 'the available commands, one with an input hint',
    raw: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Compact the conversation', input: { hint: '[focus]' } },
        { name: 'review', description: 'Review a change' },
      ],
    },
    expected: {
      kind: 'available_commands',
      commands: [
        { name: 'compact', description: 'Compact the conversation', inputHint: '[focus]' },
        { name: 'review', description: 'Review a change' },
      ],
    },
  },
  {
    name: 'a mode change',
    raw: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    expected: {
      kind: 'config_changed',
      options: [{ id: 'mode', category: 'mode', value: 'plan' }],
    },
  },
  {
    name: 'a config option update',
    raw: {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'model', category: 'model', type: 'select', currentValue: 'haiku' },
        { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low' },
      ],
    },
    expected: {
      kind: 'config_changed',
      options: [
        { id: 'model', category: 'model', value: 'haiku' },
        { id: 'effort', category: 'thought_level', value: 'low' },
      ],
    },
  },
  {
    name: 'a usage update with the context counters, the cost and the model',
    raw: {
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
      cost: { amount: 0.0123, currency: 'USD' },
      _meta: { '_claude/model': 'claude-haiku-5-5' },
    },
    expected: {
      kind: 'usage',
      model: 'claude-haiku-5-5',
      contextUsed: 1200,
      contextSize: 200000,
      costUsd: 0.0123,
    },
  },
  {
    name: 'a usage update with a cost in another currency',
    raw: {
      sessionUpdate: 'usage_update',
      used: 10,
      size: 100,
      cost: { amount: 1, currency: 'BRL' },
    },
    expected: { kind: 'usage', contextUsed: 10, contextSize: 100 },
  },
  {
    name: 'a usage update with nothing to count',
    raw: { sessionUpdate: 'usage_update', _meta: { '_claude/origin': 'sdk' } },
    expected: null,
  },
  {
    name: 'the replay of a user message (session/load)',
    raw: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    expected: null,
  },
  {
    name: 'a session info update',
    raw: { sessionUpdate: 'session_info_update', title: 'A title' },
    expected: null,
  },
  { name: 'something that is not an object', raw: 'oops', expected: null },
];

/** A `usage_update` that carries the rate-limit event of the Agent SDK (Phase 0 item 9 [V]; values invented). */
export const RATE_LIMIT_UPDATE: unknown = {
  sessionUpdate: 'usage_update',
  used: 5000,
  size: 200000,
  _meta: {
    '_claude/rateLimit': {
      status: 'allowed_warning',
      resetsAt: 1_800_000_000,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.83, resetsAt: 1_800_000_000, status: 'allowed_warning' },
        seven_day: { utilization: 0.12, resetsAt: 1_800_400_000, status: 'allowed' },
      },
    },
  },
};
