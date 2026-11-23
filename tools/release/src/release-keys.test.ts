// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  checkProductionKey,
  generateEphemeralKey,
  publicPemOf,
  signManifest,
  SigningKeyError,
} from './sign.js';

// Every key here is made by the test, at run time: no key, not even a test one, is in the repository.

describe('the ephemeral key', () => {
  it('makes a new pair each time, and the public half belongs to the private one', () => {
    const a = generateEphemeralKey();
    const b = generateEphemeralKey();
    expect(a.privatePem).not.toBe(b.privatePem);
    expect(publicPemOf(a.privatePem)).toBe(a.publicPem);
  });

  it('signs bytes in base64 with a trailing newline', () => {
    const { privatePem } = generateEphemeralKey();
    const signature = signManifest(Buffer.from('{}'), privatePem);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}\n$/);
    // Ed25519 is deterministic: same bytes and key, same signature.
    expect(signManifest(Buffer.from('{}'), privatePem)).toBe(signature);
  });

  it('refuses a key that is not an Ed25519 private key, without echoing it', () => {
    const { publicPem } = generateEphemeralKey();
    expect(() => signManifest(Buffer.from('{}'), publicPem)).toThrow(SigningKeyError);
    expect(() => signManifest(Buffer.from('{}'), 'not a key')).toThrow(/not a private key/);
  });
});

describe('checkProductionKey', () => {
  const placeholder = 'PLACEHOLDER\n';

  it('accepts the secret whose public key is the one of the repository', () => {
    const pair = generateEphemeralKey();
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: pair.publicPem })).toEqual({
      ok: true,
    });
  });

  it('refuses a secret that does not exist or is empty', () => {
    const pair = generateEphemeralKey();
    for (const privatePem of [undefined, '', '   \n']) {
      expect(checkProductionKey({ privatePem, publicPem: pair.publicPem })).toMatchObject({
        ok: false,
        reason: 'secret_missing',
      });
    }
  });

  it('refuses the wrong key: the public key of the secret is not the one of the repository', () => {
    const secret = generateEphemeralKey();
    const repository = generateEphemeralKey();
    expect(
      checkProductionKey({ privatePem: secret.privatePem, publicPem: repository.publicPem }),
    ).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('refuses the PLACEHOLDER of the repository', () => {
    const secret = generateEphemeralKey();
    expect(
      checkProductionKey({ privatePem: secret.privatePem, publicPem: placeholder }),
    ).toMatchObject({ ok: false, reason: 'public_placeholder' });
  });

  it('refuses a missing public file, a public file that is not a key and a secret that is not a key', () => {
    const pair = generateEphemeralKey();
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: undefined })).toMatchObject(
      {
        reason: 'public_missing',
      },
    );
    expect(checkProductionKey({ privatePem: pair.privatePem, publicPem: 'garbage' })).toMatchObject(
      {
        reason: 'public_invalid',
      },
    );
    expect(checkProductionKey({ privatePem: 'garbage', publicPem: pair.publicPem })).toMatchObject({
      reason: 'secret_invalid',
    });
  });

  it('never puts key material in the message', () => {
    const secret = generateEphemeralKey();
    const repository = generateEphemeralKey();
    const result = checkProductionKey({
      privatePem: secret.privatePem,
      publicPem: repository.publicPem,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('BEGIN');
      expect(result.message).not.toContain(secret.privatePem.split('\n')[1] ?? 'x');
    }
  });
});
