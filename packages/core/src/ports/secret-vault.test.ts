// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { assertSecretKey, SecretKeySchema } from './secret-vault.js';

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
