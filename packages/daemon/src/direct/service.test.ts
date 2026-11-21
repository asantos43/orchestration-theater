// SPDX-License-Identifier: MPL-2.0
import type { RolePolicy } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { directPolicyOf } from './service.js';

const ACTOR: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'shells',
  mcpServers: ['otheater'],
  mcpTools: { otheater: ['restricted_shell'] },
  onAsk: 'rules',
  rules: [],
  editInWorktree: 'allow',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

describe('the policy of a direct session', () => {
  it('takes the shells of the daemon and the MCP servers away in every workspace', () => {
    for (const workspace of ['worktree', 'scenario'] as const) {
      const policy = directPolicyOf(ACTOR, workspace);
      expect(policy).toMatchObject({ nativeShell: 'none', mcpServers: [], mcpTools: {} });
      // The rest is the Actor's.
      expect(policy.nativeTools).toEqual(ACTOR.nativeTools);
      expect(policy.onAsk).toBe('rules');
      expect(policy.editInWorktree).toBe('allow');
    }
  });

  it('keeps only reading and searching in a readonly session, and rejects every ask', () => {
    const policy = directPolicyOf(ACTOR, 'readonly');
    expect(policy.nativeTools).toEqual(['read', 'search']);
    expect(policy).toMatchObject({
      nativeShell: 'none',
      mcpServers: [],
      onAsk: 'reject',
      editInWorktree: 'ask',
      rules: [],
    });
  });

  it('does not change the policy it was given', () => {
    directPolicyOf(ACTOR, 'readonly');
    expect(ACTOR.nativeTools).toHaveLength(4);
    expect(ACTOR.onAsk).toBe('rules');
  });
});
