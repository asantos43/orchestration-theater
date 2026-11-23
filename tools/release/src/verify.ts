// SPDX-License-Identifier: MPL-2.0
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseManifest, type UpdateManifest } from '@otheater/daemon/updates/manifest';
import { parsePublicKey, sha256OfFile, verifySignature } from '@otheater/daemon/updates/verify';

/**
 * `verify-manifest` (Phase 10, P9): the same check the daemon makes, run on the release before it
 * leaves the job. The signature and the manifest are read with the code of
 * `packages/daemon/src/updates/{verify,manifest}.ts` (imported, not copied); the only addition is the
 * check of the files next to the manifest (size and SHA-256), which the daemon makes on download.
 */

export type ReleaseVerifyReason =
  | 'key_placeholder'
  | 'key_invalid'
  | 'bad_signature'
  | 'bad_manifest'
  | 'missing_file'
  | 'size_mismatch'
  | 'hash_mismatch';

export class ReleaseVerifyError extends Error {
  constructor(
    readonly reason: ReleaseVerifyReason,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifyOptions {
  readonly manifestBytes: Uint8Array;
  /** The text of `manifest.json.sig` (base64). */
  readonly signature: string;
  /** The public key (PEM) to check with. The PLACEHOLDER checks nothing and is refused. */
  readonly publicPem: string;
  /** When given, every asset of the manifest has to be in this folder with the size and hash it says. */
  readonly assetsDir?: string | undefined;
}

/** Returns the manifest when everything checks; throws {@link ReleaseVerifyError} with the reason otherwise. */
export async function verifyRelease(options: VerifyOptions): Promise<UpdateManifest> {
  const key = parsePublicKey(options.publicPem);
  if (key.state === 'placeholder') {
    throw new ReleaseVerifyError(
      'key_placeholder',
      'the public key is the PLACEHOLDER: nothing can be checked with it',
    );
  }
  if (key.state !== 'valid') {
    throw new ReleaseVerifyError('key_invalid', 'the public key is not an Ed25519 public key');
  }
  if (!verifySignature(options.manifestBytes, options.signature, key.key)) {
    throw new ReleaseVerifyError(
      'bad_signature',
      'the signature does not match the manifest and the key',
    );
  }
  let manifest: UpdateManifest;
  try {
    manifest = parseManifest(options.manifestBytes);
  } catch (error) {
    // parseManifest throws only its own "bad manifest" stop; its message says what is wrong.
    throw new ReleaseVerifyError(
      'bad_manifest',
      error instanceof Error ? error.message : 'the manifest is not valid',
    );
  }
  if (options.assetsDir !== undefined) {
    for (const asset of manifest.assets) {
      const file = path.join(options.assetsDir, asset.name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) {
        throw new ReleaseVerifyError(
          'missing_file',
          `${asset.name} is in the manifest and not in the folder`,
        );
      }
      if (info.size !== asset.size) {
        throw new ReleaseVerifyError(
          'size_mismatch',
          `${asset.name} has ${String(info.size)} bytes, the manifest says ${String(asset.size)}`,
        );
      }
      if ((await sha256OfFile(file)) !== asset.sha256) {
        throw new ReleaseVerifyError(
          'hash_mismatch',
          `${asset.name} does not match the SHA-256 of the manifest`,
        );
      }
    }
  }
  return manifest;
}
