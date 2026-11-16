// SPDX-License-Identifier: MPL-2.0

/**
 * HAND-BUILT, not a capture. The shapes follow the `session/update` types Phase 0 saw from
 * `codex-acp` 2.6.0 (`spikes/acp-codex`, item 3) [V] and the ACP schema [S]; the values are made
 * up. Nothing here comes from a real account: no id, path, e-mail or token.
 */

export const AGENT_MESSAGE_CHUNK = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'hello' },
  messageId: 'msg-1',
} as const;

export const AGENT_THOUGHT_CHUNK = {
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text: 'thinking' },
} as const;

export const TOOL_CALL = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'Run ls',
  kind: 'execute',
  status: 'in_progress',
  locations: [{ path: '/work/src/a.ts', line: 3 }, { path: '/work/src/b.ts' }, { line: 1 }],
  rawInput: { command: ['ls'] },
} as const;

export const TOOL_CALL_UPDATE = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call-1',
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: 'a.ts' } }],
} as const;

export const PLAN = {
  sessionUpdate: 'plan',
  entries: [
    { content: 'read', priority: 'high', status: 'completed' },
    { content: 'edit', priority: 'medium', status: 'in_progress' },
    { content: 'test', priority: 'whatever', status: 'whatever' },
    { priority: 'low', status: 'pending' },
  ],
} as const;

export const USAGE_UPDATE = {
  sessionUpdate: 'usage_update',
  used: 1200,
  size: 258000,
  cost: { amount: 0.25, currency: 'USD' },
} as const;

export const AVAILABLE_COMMANDS_UPDATE = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [
    { name: 'review', description: 'Review the changes', input: { hint: 'what to review' } },
    { name: 'compact', description: 'Compact the context' },
    { description: 'no name' },
  ],
} as const;

export const CURRENT_MODE_UPDATE = {
  sessionUpdate: 'current_mode_update',
  currentModeId: 'workspace-write',
} as const;

export const CONFIG_OPTION_UPDATE = {
  sessionUpdate: 'config_option_update',
  configOptions: [
    { id: 'model', category: 'model', currentValue: 'model-a' },
    { id: 'fast-mode', currentValue: true },
    { id: 'broken' },
  ],
} as const;

/** Swallowed: the title and the thread status; `_meta.codex.error` shows up during retries. */
export const SESSION_INFO_UPDATE = {
  sessionUpdate: 'session_info_update',
  title: 'A title',
  _meta: {
    codex: { threadStatus: { type: 'systemError' }, error: { message: 'x', willRetry: true } },
  },
} as const;

/** Swallowed: only seen while `session/load` replays the history. */
export const USER_MESSAGE_CHUNK = {
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text: 'earlier prompt' },
} as const;
