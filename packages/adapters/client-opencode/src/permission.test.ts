// SPDX-License-Identifier: MPL-2.0
import type { RolePolicy } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_KEYS,
  DENY_ALL_POLICY,
  mcpToolPrefix,
  opencodePermission,
  serializePermission,
} from './permission.js';

const policy = (patch: Partial<RolePolicy> = {}): RolePolicy => ({
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
  ...patch,
});

describe('opencodePermission', () => {
  it('starts from "*": ask, so the first key of the object is the catch-all', () => {
    expect(Object.keys(opencodePermission(policy()))[0]).toBe('*');
    expect(opencodePermission(policy())['*']).toBe('ask');
  });

  it('allows the tools the role has and denies (removes) the others', () => {
    const reader = opencodePermission(policy({ nativeTools: ['read', 'search'] }));
    expect(reader).toMatchObject({
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'deny',
    });
    const writer = opencodePermission(policy({ nativeTools: ['read', 'edit'] }));
    expect(writer).toMatchObject({ read: 'allow', glob: 'deny', grep: 'deny', edit: 'allow' });
    expect(opencodePermission(policy({ nativeTools: ['write'] })).edit).toBe('allow');
  });

  it('always denies the shell, the tools outside the four native ones and external directories', () => {
    for (const nativeTools of [[], ['read', 'search', 'edit', 'write']] as const) {
      const rules = opencodePermission(policy({ nativeTools }));
      expect(rules).toMatchObject({
        bash: 'deny',
        external_directory: 'deny',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        skill: 'deny',
      });
    }
  });

  it('shell keys are a setting: a client that calls the shell "shell" is covered too', () => {
    expect(DEFAULT_SHELL_KEYS).toEqual(['bash']);
    const rules = opencodePermission(policy(), { shellKeys: ['bash', 'shell'] });
    expect(rules).toMatchObject({ bash: 'deny', shell: 'deny' });
    expect(opencodePermission(policy())).not.toHaveProperty('shell');
  });

  it('allows only the MCP servers of the role, by their prefix', () => {
    const rules = opencodePermission(policy({ mcpServers: ['otheater-shells', 'my server'] }));
    expect(rules['otheater-shells_*']).toBe('allow');
    expect(rules['my_server_*']).toBe('allow');
    expect(mcpToolPrefix('a.b/c')).toBe('a_b_c');
  });

  it('is pure and does not change the policy', () => {
    const input = policy({ mcpServers: ['x'] });
    const before = JSON.stringify(input);
    expect(opencodePermission(input)).toEqual(opencodePermission(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('serializes to JSON that keeps the order of the keys', () => {
    const text = serializePermission(opencodePermission(policy()));
    expect(text.startsWith('{"*":"ask"')).toBe(true);
    expect(JSON.parse(text)).toEqual(opencodePermission(policy()));
  });

  it('a policy with nothing allows nothing: the fail-closed one', () => {
    const rules = opencodePermission(DENY_ALL_POLICY);
    expect(Object.entries(rules).filter(([, action]) => action === 'allow')).toEqual([]);
  });
});
