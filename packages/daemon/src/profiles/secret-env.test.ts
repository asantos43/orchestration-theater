// SPDX-License-Identifier: MPL-2.0
import { Secret, VaultLocked } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { apiKeyRefOf, profileApiKey, profileProvider } from './secret-env.js';

const KEY = 'sk-test-0000-not-a-real-key';
const MM = { client: 'opencode', profile: 'mm' };

function rig() {
  const store = new InMemoryStore({ clock: new FakeClock(0) });
  const vault = new InMemorySecretVault();
  return { store, vault };
}

describe('profileApiKey (the key for a call the daemon makes itself)', () => {
  it('gives the key of an API profile from the vault, and nothing for the rest', async () => {
    const { store, vault } = rig();
    const ref = apiKeyRefOf('opencode', 'mm');
    await vault.set(ref, new Secret(KEY));
    await store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: ref,
    });
    await store.profiles.create({
      client: 'opencode',
      name: 'sub',
      kind: 'token_plan',
      provider: 'minimax',
      dir: '/p/sub',
      secretRef: null,
    });
    const keyOf = profileApiKey({ store, vault });
    expect(await keyOf(MM)).toBe(KEY);
    expect(await keyOf({ client: 'opencode', profile: 'sub' })).toBeUndefined();
    expect(await keyOf({ client: 'opencode', profile: 'nobody' })).toBeUndefined();
  });

  it('gives nothing for a removed profile or a key that left the vault, and warns without the key', async () => {
    const { store, vault } = rig();
    const ref = apiKeyRefOf('opencode', 'mm');
    await store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: ref,
    });
    const warnings: unknown[] = [];
    const keyOf = profileApiKey({
      store,
      vault,
      logger: { warn: (...a: unknown[]) => void warnings.push(a) },
    });
    expect(await keyOf(MM)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    await vault.set(ref, new Secret(KEY));
    expect(await keyOf(MM)).toBe(KEY);
    await store.profiles.update('opencode/mm', { state: 'draining' });
    await store.profiles.update('opencode/mm', { state: 'removed' });
    expect(await keyOf(MM)).toBeUndefined();
    expect(JSON.stringify(warnings)).not.toContain(KEY);
  });

  it('lets a locked vault reject, so the caller sees no reading', async () => {
    const { store, vault } = rig();
    const ref = apiKeyRefOf('opencode', 'mm');
    await store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'api',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: ref,
    });
    vault.lock();
    await expect(profileApiKey({ store, vault })(MM)).rejects.toBeInstanceOf(VaultLocked);
  });
});

describe('profileProvider', () => {
  it('gives the provider of a registered profile, and undefined for another', async () => {
    const { store } = rig();
    await store.profiles.create({
      client: 'opencode',
      name: 'mm',
      kind: 'token_plan',
      provider: 'minimax',
      dir: '/p/mm',
      secretRef: null,
    });
    const providerOf = profileProvider({ store });
    expect(await providerOf(MM)).toBe('minimax');
    expect(await providerOf({ client: 'opencode', profile: 'x' })).toBeUndefined();
  });
});
