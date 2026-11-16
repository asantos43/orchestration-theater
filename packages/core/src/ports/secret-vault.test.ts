// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { Secret } from '../secret.js';
import { InMemorySecretVault } from '../testing/index.js';
import {
  assertSecretKey,
  isLockableSecretVault,
  SecretKeySchema,
  type SecretVault,
} from './secret-vault.js';

describe('secret keys', () => {
  it('accept path-like names', () => {
    for (const key of ['a', 'profile/minimax-main/api-key', 'Prof.1:key_2', '9lives']) {
      expect(SecretKeySchema.safeParse(key).success, key).toBe(true);
      expect(() => {
        assertSecretKey(key);
      }).not.toThrow();
    }
  });

  it('reject empty, spaces, leading symbols, control chars and over 256 chars', () => {
    for (const key of ['', ' ', 'a b', '/a', '-a', '.a', 'a\n', 'a'.repeat(257), 'ação']) {
      expect(SecretKeySchema.safeParse(key).success, JSON.stringify(key)).toBe(false);
      expect(() => {
        assertSecretKey(key);
      }).toThrow(/Invalid secret key/);
    }
  });
});

/** The four `SecretVault` methods and nothing else (no `lock`/`unlock` of the in-memory fake). */
function plainVault(): SecretVault {
  const base = new InMemorySecretVault();
  return {
    get: (key) => base.get(key),
    set: (key, value) => base.set(key, value),
    delete: (key) => base.delete(key),
    list: (prefix) => base.list(prefix),
  };
}

describe('isLockableSecretVault', () => {
  it('is false for a plain vault', () => {
    expect(isLockableSecretVault(plainVault())).toBe(false);
  });

  it('is true for a vault with isLocked, unlock and lock', () => {
    const lockable: SecretVault = {
      ...plainVault(),
      isLocked: true,
      unlock: (password: Secret) => Promise.resolve(password).then(() => undefined),
      lock: () => undefined,
    } as SecretVault;
    expect(isLockableSecretVault(lockable)).toBe(true);
  });

  it('is false when a member is missing or has the wrong type', () => {
    const noLock = {
      ...plainVault(),
      isLocked: false,
      unlock: () => Promise.resolve(),
    } as SecretVault;
    expect(isLockableSecretVault(noLock)).toBe(false);
    const badFlag = {
      ...plainVault(),
      isLocked: 'yes',
      unlock: () => Promise.resolve(),
      lock: () => undefined,
    } as unknown as SecretVault;
    expect(isLockableSecretVault(badFlag)).toBe(false);
    const noUnlock = { ...plainVault(), isLocked: true, lock: () => undefined } as SecretVault;
    expect(isLockableSecretVault(noUnlock)).toBe(false);
  });
});
