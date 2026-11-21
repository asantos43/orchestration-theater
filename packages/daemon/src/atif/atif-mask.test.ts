// SPDX-License-Identifier: MPL-2.0
import { Secret } from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { REDACTED_VALUE } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { createMasker, MIN_SECRET_LENGTH, vaultValues } from './atif-mask.js';

describe('the masker of the ATIF export (P5)', () => {
  it('replaces every occurrence of a value of the vault, the longest first', () => {
    const mask = createMasker(['abcd-secret', 'abcd-secret-and-more']);
    expect(mask('a abcd-secret-and-more b abcd-secret c abcd-secret')).toBe(
      `a ${REDACTED_VALUE} b ${REDACTED_VALUE} c ${REDACTED_VALUE}`,
    );
  });

  it('leaves out values shorter than the minimum, which would cut ordinary words', () => {
    const short = 'x'.repeat(MIN_SECRET_LENGTH - 1);
    expect(createMasker([short, ''])(`the ${short} stays`)).toBe(`the ${short} stays`);
    const exact = 'y'.repeat(MIN_SECRET_LENGTH);
    expect(createMasker([exact])(`the ${exact} goes`)).toBe(`the ${REDACTED_VALUE} goes`);
  });

  it('also masks the shapes of keys and of NAME=value, with no value of the vault', () => {
    const mask = createMasker([]);
    expect(mask('export API_KEY=hunter2-not-in-any-vault')).not.toContain(
      'hunter2-not-in-any-vault',
    );
    expect(mask('key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end')).not.toContain(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(mask('plain text')).toBe('plain text');
  });

  it('reads the values of the vault, and rejects when the vault cannot be read', async () => {
    const vault = new InMemorySecretVault();
    await vault.set('profiles/a/api_key', new Secret('value-one-1234'));
    await vault.set('profiles/b/api_key', new Secret('value-two-5678'));
    expect((await vaultValues(vault)).sort()).toEqual(['value-one-1234', 'value-two-5678']);
    vault.lock();
    await expect(vaultValues(vault)).rejects.toThrow();
  });
});
