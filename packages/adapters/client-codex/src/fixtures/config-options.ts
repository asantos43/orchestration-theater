// SPDX-License-Identifier: MPL-2.0

/**
 * HAND-BUILT, not a capture. The shape of the `configOptions` of `session/new` from `codex-acp`
 * 2.6.0 as Phase 0 listed them (`spikes/acp-codex`, item 2) [V]: five options, `mode`, `model`,
 * `reasoning_effort`, `collaboration_mode` and `fast-mode`. The model and effort names are
 * invented (the real catalog has 8 models); the grouped form is the one of the ACP schema [S].
 */
export const CONFIG_OPTIONS = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'agent',
    options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
      { value: 'agent', name: 'Auto review' },
      { value: 'agent-full-access', name: 'Full access' },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'model-a',
    options: [
      { value: 'model-a', name: 'Model A' },
      { group: 'older', name: 'Older', options: [{ value: 'model-b', name: 'Model B' }] },
      { name: 'no value' },
    ],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  { id: 'fast-mode', name: 'Fast mode', type: 'boolean', currentValue: false },
] as const;
