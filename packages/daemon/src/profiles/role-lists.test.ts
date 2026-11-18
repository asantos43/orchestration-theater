// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { roleListsOf } from './role-lists.js';

const YAML = `
executors:
  m-high@claude-code/main:
    client: claude-code
    profile: main
    model: m
    effort: high
  m-high@codex/key:
    client: codex
    profile: key
    model: m
    effort: high
roles:
  actor: { executors: [m-high@claude-code/main] }
  reviewer: { executors: [m-high@claude-code/main, m-high@codex/key] }
`;

describe('roleListsOf (P21)', () => {
  it('reads the lists over the profiles of the store, and a removed profile turns invalid', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    for (const [client, name] of [
      ['claude-code', 'main'],
      ['codex', 'key'],
    ] as const) {
      await store.profiles.create({
        client,
        name,
        kind: 'token_plan',
        provider: 'p',
        dir: `/profiles/${client}/${name}`,
      });
    }
    const lists = roleListsOf(parseConfig(YAML), store);
    const before = await lists();
    expect(before.find((list) => list.role === 'actor')?.executors).toEqual([
      { profileId: 'claude-code/main', valid: true },
    ]);

    await store.profiles.update('claude-code/main', { state: 'draining' });
    await store.profiles.update('claude-code/main', { state: 'removed' });
    const after = await lists();
    expect(after.find((list) => list.role === 'actor')?.executors).toEqual([
      { profileId: 'claude-code/main', valid: false },
    ]);
    expect(after.find((list) => list.role === 'reviewer')?.executors).toEqual([
      { profileId: 'claude-code/main', valid: false },
      { profileId: 'codex/key', valid: true },
    ]);
  });
});
