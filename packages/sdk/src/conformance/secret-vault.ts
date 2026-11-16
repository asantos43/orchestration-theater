// SPDX-License-Identifier: MPL-2.0
import { SECRET_VAULT_PORT_VERSION, Secret, type SecretVault } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface SecretVaultHarness extends Disposable {
  readonly vault: SecretVault;
  /**
   * Optional: put the vault in the locked state (and back). Provide both when the adapter can be
   * locked on demand (a fake can; a real keyring usually cannot) to run the `VAULT_LOCKED` tests.
   */
  readonly lock?: () => Promise<void> | void;
  readonly unlock?: () => Promise<void> | void;
}

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/** Registers the `SecretVault` conformance tests (port version {@link SECRET_VAULT_PORT_VERSION}). */
export function describeSecretVaultConformance(
  name: string,
  factory: AdapterFactory<SecretVaultHarness>,
): void {
  describe(`SecretVault conformance: ${name} (port ${SECRET_VAULT_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    it('get returns undefined for a missing key', async () => {
      expect(await harness().vault.get('missing/key')).toBeUndefined();
    });

    it('set then get round-trips the value through reveal()', async () => {
      const { vault } = harness();
      await vault.set('profile/main/api-key', new Secret('sk-test-123'));
      const secret = await vault.get('profile/main/api-key');
      expect(secret).toBeInstanceOf(Secret);
      expect(secret?.reveal()).toBe('sk-test-123');
    });

    it('round-trips awkward values: empty, unicode, newlines, long', async () => {
      const { vault } = harness();
      const values = ['', 'çã 🔑 日本語', 'line1\nline2\r\n\t"q"', 'x'.repeat(10_000)];
      for (const [i, value] of values.entries()) {
        await vault.set(`awkward/${String(i)}`, new Secret(value));
        expect((await vault.get(`awkward/${String(i)}`))?.reveal()).toBe(value);
      }
    });

    it('set replaces an existing value', async () => {
      const { vault } = harness();
      await vault.set('k', new Secret('one'));
      await vault.set('k', new Secret('two'));
      expect((await vault.get('k'))?.reveal()).toBe('two');
      expect(await vault.list()).toEqual(['k']);
    });

    it('keys are case-sensitive', async () => {
      const { vault } = harness();
      await vault.set('Key', new Secret('upper'));
      await vault.set('key', new Secret('lower'));
      expect((await vault.get('Key'))?.reveal()).toBe('upper');
      expect((await vault.get('key'))?.reveal()).toBe('lower');
    });

    it('delete reports whether the key existed and is idempotent', async () => {
      const { vault } = harness();
      await vault.set('k', new Secret('v'));
      expect(await vault.delete('k')).toBe(true);
      expect(await vault.get('k')).toBeUndefined();
      expect(await vault.delete('k')).toBe(false);
    });

    it('list returns sorted keys, optionally by prefix, and never values', async () => {
      const { vault } = harness();
      expect(await vault.list()).toEqual([]);
      await vault.set('b/two', new Secret('VALUE-B2'));
      await vault.set('a/one', new Secret('VALUE-A1'));
      await vault.set('b/one', new Secret('VALUE-B1'));

      expect(await vault.list()).toEqual(['a/one', 'b/one', 'b/two']);
      expect(await vault.list('b/')).toEqual(['b/one', 'b/two']);
      expect(await vault.list('zzz')).toEqual([]);
      expect(JSON.stringify(await vault.list())).not.toContain('VALUE-');
    });

    it('rejects invalid keys with INVALID_INPUT', async () => {
      const { vault } = harness();
      const keys = ['', ' ', 'has space', '/leading-slash', '-dash', 'tab\t', 'a'.repeat(257)];
      for (const key of keys) {
        expect(await rejectionOf(vault.get(key))).toMatchObject({ code: 'INVALID_INPUT' });
        expect(await rejectionOf(vault.set(key, new Secret('v')))).toMatchObject({
          code: 'INVALID_INPUT',
        });
        expect(await rejectionOf(vault.delete(key))).toMatchObject({ code: 'INVALID_INPUT' });
      }
    });

    it('the secret returned by get does not leak by accident', async () => {
      const { vault } = harness();
      const plain = 'sk-live-do-not-leak-0123456789';
      await vault.set('leak/test', new Secret(plain));
      const secret = await vault.get('leak/test');
      if (secret === undefined) throw new Error('secret not stored');

      const renderings = [
        String(secret),
        secret.toString(),
        `key=${secret as unknown as string}`,
        JSON.stringify(secret),
        JSON.stringify({ nested: { secret }, list: [secret] }),
        JSON.stringify(Object.entries(secret)),
        JSON.stringify(Object.assign({}, secret)),
        JSON.stringify(Object.getOwnPropertyNames(secret)),
        String((secret as unknown as Record<symbol, () => string>)[INSPECT_CUSTOM]?.()),
      ];
      for (const text of renderings) expect(text).not.toContain(plain);
      expect(secret.reveal()).toBe(plain);
    });

    it('an error about a bad key does not echo secret values', async () => {
      const { vault } = harness();
      const plain = 'sk-live-in-the-error-path';
      const error = await rejectionOf(vault.set('bad key', new Secret(plain)));
      expect(String(error)).not.toContain(plain);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(plain);
    });

    describe('when locked', () => {
      it('rejects every operation with VAULT_LOCKED, and works again after unlock', async () => {
        const { vault, lock, unlock } = harness();
        if (lock === undefined || unlock === undefined) return; // adapter cannot be locked on demand
        await vault.set('k', new Secret('v'));
        await lock();
        const operations = [
          () => vault.get('k'),
          () => vault.set('k2', new Secret('v')),
          () => vault.delete('k'),
          () => vault.list(),
        ];
        for (const operation of operations) {
          expect(await rejectionOf(operation())).toMatchObject({ code: 'VAULT_LOCKED' });
        }
        await unlock();
        expect((await vault.get('k'))?.reveal()).toBe('v');
      });
    });
  });
}
