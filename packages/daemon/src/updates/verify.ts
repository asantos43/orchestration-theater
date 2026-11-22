// SPDX-License-Identifier: MPL-2.0
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { UPDATE_KEY_STATES } from '@otheater/protocol';

/**
 * The checks of a release (Phase 10, P7): the Ed25519 signature of the manifest and the SHA-256 of
 * a file. The public key is always a PARAMETER: the executable embeds it at build time
 * (`tools/release/keys/update-public-key.pem`) and the tests hand in a key made in the test. There
 * is no key in the user's configuration, because a key one can change would not check anything.
 */

/** Whether the daemon has a public key it can check a manifest with (the status of `/v1/updates`). */
export type UpdateKeyState = (typeof UPDATE_KEY_STATES)[number];

/** A public key the daemon can check with, or why it cannot. */
export type PublicKeyResult =
  | { readonly state: 'valid'; readonly key: KeyObject }
  | { readonly state: Exclude<UpdateKeyState, 'valid'>; readonly key?: undefined };

const PLACEHOLDER = /^\s*PLACEHOLDER\b/;

/**
 * Reads the text of a public key (PEM, Ed25519). The placeholder the repository carries until the
 * owner makes the real key is `placeholder`: nothing is checked with it. [proposta] Anything that
 * is not an Ed25519 public key is `invalid`, never a thrown error.
 */
export function parsePublicKey(pem: string | undefined): PublicKeyResult {
  if (pem === undefined || pem.trim() === '') return { state: 'invalid' };
  if (PLACEHOLDER.test(pem)) return { state: 'placeholder' };
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? { state: 'valid', key } : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * True when `signature` (base64 text) is the Ed25519 signature of exactly `bytes` made by the key.
 * It never throws: a signature that is not base64, or not 64 bytes, is false.
 */
export function verifySignature(
  bytes: Uint8Array,
  signature: string,
  publicKey: KeyObject,
): boolean {
  const text = signature.trim();
  if (text === '' || text.length > 128 || !BASE64.test(text)) return false;
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    return verify(null, bytes, publicKey, raw);
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The SHA-256 of a file, read as a stream. */
export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}
