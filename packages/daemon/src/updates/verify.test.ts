// SPDX-License-Identifier: MPL-2.0
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeKeys } from './release-fixture.js';
import { parsePublicKey, sha256Hex, sha256OfFile, verifySignature } from './verify.js';

describe('the public key', () => {
  it('reads an Ed25519 public key', () => {
    expect(parsePublicKey(makeKeys().publicPem).state).toBe('valid');
  });

  it('the placeholder of the repository is not a key and is said so', () => {
    expect(parsePublicKey('PLACEHOLDER\n').state).toBe('placeholder');
    expect(parsePublicKey('  PLACEHOLDER: the owner makes the key')).toEqual({
      state: 'placeholder',
    });
  });

  it('nothing, text and keys of another kind are invalid, never an error', () => {
    expect(parsePublicKey(undefined).state).toBe('invalid');
    expect(parsePublicKey('').state).toBe('invalid');
    expect(parsePublicKey('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----').state).toBe(
      'invalid',
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    expect(parsePublicKey(rsa.toString()).state).toBe('invalid');
  });
});

describe('the signature', () => {
  const bytes = Buffer.from('{"schema":1}');

  it('is good for the exact bytes and the key that signed', () => {
    const keys = makeKeys();
    expect(verifySignature(bytes, keys.sign(bytes), keys.publicKey)).toBe(true);
    expect(verifySignature(bytes, `${keys.sign(bytes)}\n`, keys.publicKey)).toBe(true);
  });

  it('is bad for another key, another byte, and what is not a signature', () => {
    const keys = makeKeys();
    const signature = keys.sign(bytes);
    expect(verifySignature(bytes, makeKeys().sign(bytes), keys.publicKey)).toBe(false);
    expect(verifySignature(Buffer.from('{"schema":2}'), signature, keys.publicKey)).toBe(false);
    expect(verifySignature(Buffer.from(`${bytes.toString()}\n`), signature, keys.publicKey)).toBe(
      false,
    );
    for (const text of ['', 'not base64!', 'AAAA', 'A'.repeat(500), signature.slice(0, -4)]) {
      expect(verifySignature(bytes, text, keys.publicKey)).toBe(false);
    }
  });
});

describe('the SHA-256', () => {
  it('is the one of the bytes and of the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ot-sha-'));
    try {
      const file = join(dir, 'file');
      await writeFile(file, 'abc');
      const known = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      expect(sha256Hex(Buffer.from('abc'))).toBe(known);
      expect(await sha256OfFile(file)).toBe(known);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
