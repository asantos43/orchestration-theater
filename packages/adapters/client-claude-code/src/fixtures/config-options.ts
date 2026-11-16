// SPDX-License-Identifier: MPL-2.0

/**
 * The `configOptions` of a `session/new` answer of `claude-agent-acp`, rebuilt by hand from what
 * Phase 0 item 2 listed [V: the ids and the values; `claude` 2.1.325, adapter 0.107.0]. The
 * descriptions and the exact nesting are invented (ACP `SessionConfigOption`, `select` type).
 */
export const SESSION_NEW_CONFIG_OPTIONS: readonly unknown[] = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'auto',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'acceptEdits', name: 'Accept Edits' },
      { value: 'plan', name: 'Plan Mode' },
      { value: 'auto', name: 'Auto' },
      { value: 'bypassPermissions', name: 'Bypass Permissions' },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'sonnet',
    options: [
      { value: 'default', name: 'Default (recommended)' },
      { value: 'opus', name: 'Opus' },
      { value: 'claude-fable-5-2[1m]', name: 'Fable 5.2 (1M context)' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'haiku', name: 'Haiku' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Max' },
    ],
  },
  {
    id: 'ultracode',
    name: 'Ultracode',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' },
    ],
  },
];

/** The same `model` option with its values grouped, as ACP allows (`SessionConfigSelectGroup`). */
export const GROUPED_CONFIG_OPTIONS: readonly unknown[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'sonnet',
    options: [
      { group: 'aliases', name: 'Aliases', options: [{ value: 'opus' }, { value: 'sonnet' }] },
      { group: 'pinned', name: 'Pinned', options: [{ value: 'claude-haiku-5-5', name: 'Haiku' }] },
    ],
  },
];
