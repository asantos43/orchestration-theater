// SPDX-License-Identifier: MPL-2.0

/**
 * HAND-MADE `session/update` payloads in the shape of ACP 2.7 (`@agentclientprotocol/sdk`). They
 * are not captures of OpenCode (N57): the fields are the ones the schema of the protocol names,
 * the values are invented.
 */
export const ACP_UPDATES = {
  message: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
  thought: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
  userEcho: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'my prompt' } },
  toolCall: {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'bash: ls',
    kind: 'execute',
    status: 'in_progress',
  },
  toolCallDone: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
  },
  plan: {
    sessionUpdate: 'plan',
    entries: [
      { content: 'read the file', priority: 'high', status: 'completed' },
      { content: 'edit the file', priority: 'medium', status: 'in_progress' },
    ],
  },
  usage: {
    sessionUpdate: 'usage_update',
    used: 1200,
    size: 200000,
    cost: { amount: 0.0123, currency: 'USD' },
  },
  commands: {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'init', description: 'create AGENTS.md' }],
  },
  mode: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
} as const;
