// SPDX-License-Identifier: MPL-2.0
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { parsePublicKey } from '@otheater/daemon/updates/verify';

/**
 * `sign-manifest` (Phase 10, P9): the Ed25519 signature of the exact bytes of `manifest.json`, in base64
 * (`manifest.json.sig`), made with the `crypto` of Node. Two keys exist in this step and they never
 * meet: the EPHEMERAL one, made in the job of the rehearsal and thrown away with it, and the
 * PRODUCTION one, the secret `OT_UPDATE_SIGNING_KEY` that only the `publish` job reads (N246). Nothing
 * here prints or returns the text of a private key except {@link generateEphemeralKey}, whose result
 * the caller keeps in a file only the runner sees.
 */

export interface KeyPairPem {
  readonly privatePem: string;
  readonly publicPem: string;
}

/** A new Ed25519 pair, for the rehearsal. */
export function generateEphemeralKey(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export class SigningKeyError extends Error {}

/** Reads a private key in PEM text. Anything that is not an Ed25519 private key is refused, without echoing it. */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SigningKeyError('the signing key is not a private key in PEM');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SigningKeyError('the signing key is not an Ed25519 key');
  }
  return key;
}

/** The public key (PEM, SPKI) that goes with a private key. */
export function publicPemOf(privatePem: string): string {
  return createPublicKey(parsePrivateKey(privatePem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/** The signature of `manifestBytes`, base64 with a trailing newline (the file `manifest.json.sig`). */
export function signManifest(manifestBytes: Uint8Array, privatePem: string): string {
  const signature = sign(null, manifestBytes, parsePrivateKey(privatePem));
  return `${signature.toString('base64')}\n`;
}

export type KeyCheckReason =
  | 'secret_missing'
  | 'secret_invalid'
  | 'public_missing'
  | 'public_placeholder'
  | 'public_invalid'
  | 'mismatch';

export type KeyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: KeyCheckReason; readonly message: string };

const MESSAGES: Readonly<Record<KeyCheckReason, string>> = {
  secret_missing: 'the secret OT_UPDATE_SIGNING_KEY does not exist or is empty',
  secret_invalid: 'the secret OT_UPDATE_SIGNING_KEY is not an Ed25519 private key in PEM',
  public_missing: 'tools/release/keys/update-public-key.pem is not there',
  public_placeholder:
    'tools/release/keys/update-public-key.pem is still the PLACEHOLDER: the owner has not made the production key (N246)',
  public_invalid: 'tools/release/keys/update-public-key.pem is not an Ed25519 public key',
  mismatch:
    'the public key derived from the secret is not the one of tools/release/keys/update-public-key.pem (the executables embed that one)',
};

/**
 * The three checks the `publish` job makes before it signs (docs/21, P9): (a) the secret exists,
 * (b) the public key derived from it equals the one in the repository, (c) the file of the repository
 * is not the PLACEHOLDER. Any failure stops the job before a release is created. The message never
 * holds key material.
 */
export function checkProductionKey(input: {
  readonly privatePem: string | undefined;
  readonly publicPem: string | undefined;
}): KeyCheck {
  const fail = (reason: KeyCheckReason): KeyCheck => ({
    ok: false,
    reason,
    message: MESSAGES[reason],
  });
  if (input.privatePem === undefined || input.privatePem.trim() === '')
    return fail('secret_missing');
  if (input.publicPem === undefined) return fail('public_missing');
  const repository = parsePublicKey(input.publicPem);
  if (repository.state === 'placeholder') return fail('public_placeholder');
  if (repository.state !== 'valid') return fail('public_invalid');
  let derived: KeyObject;
  try {
    derived = createPublicKey(parsePrivateKey(input.privatePem));
  } catch {
    return fail('secret_invalid');
  }
  const same = derived.equals(repository.key);
  return same ? { ok: true } : fail('mismatch');
}
