// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { parsePublicKey, sha256Hex } from '@otheater/daemon/updates/verify';
import { sshPublicKeyLine } from './sign.js';

/**
 * The `install.sh` of a release (Phase 10, P9): `installer/install.sh` with the public key of the
 * release between the markers `BEGIN/END embedded public key` (P5 left the word PLACEHOLDER there and
 * said that this job replaces it). The PEM goes inside single quotes, so it has to be a clean one.
 * The same block carries the `ssh-ed25519 <base64>` line of that key (for `ssh-keygen -Y verify`, N288),
 * and a second block, `BEGIN/END embedded manifest hash`, the SHA-256 of the manifest of this very
 * release (the pinned verifier of N288: valid only for exactly that manifest).
 */

const EMBEDDED = /^EMBEDDED_PUBLIC_KEY='[^']*'$/m;
const EMBEDDED_SSH = /^EMBEDDED_SSH_KEY='[^']*'$/m;
const EMBEDDED_HASH = /^EMBEDDED_MANIFEST_SHA256='[^']*'$/m;
const BEGIN = '# BEGIN embedded public key';
const END = '# END embedded public key';
const HASH_BEGIN = '# BEGIN embedded manifest hash';
const HASH_END = '# END embedded manifest hash';

export class InstallScriptError extends Error {}

/** Returns `script` with `publicPem` embedded. Refuses the PLACEHOLDER and anything that is not an Ed25519 public key. */
export function embedPublicKey(script: string, publicPem: string): string {
  const key = parsePublicKey(publicPem);
  if (key.state === 'placeholder') {
    throw new InstallScriptError('the public key is the PLACEHOLDER: it cannot be embedded');
  }
  if (key.state !== 'valid')
    throw new InstallScriptError('the public key is not an Ed25519 public key');
  const pem = publicPem.trim();
  if (pem.includes("'") || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new InstallScriptError('the public key is not a clean PEM of a SPKI public key');
  }
  const begin = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  if (begin < 0 || end < begin)
    throw new InstallScriptError('the script has no embedded-key markers');
  const block = script.slice(begin, end);
  if (!EMBEDDED.test(block) || !EMBEDDED_SSH.test(block))
    throw new InstallScriptError('the embedded-key lines are not in the expected form');
  const ssh = sshPublicKeyLine(pem);
  // A function as the replacement: the PEM must not be read as a replacement pattern.
  return (
    script.slice(0, begin) +
    block
      .replace(EMBEDDED, () => `EMBEDDED_PUBLIC_KEY='${pem}'`)
      .replace(EMBEDDED_SSH, () => `EMBEDDED_SSH_KEY='${ssh}'`) +
    script.slice(end)
  );
}

/**
 * Returns `script` with the SHA-256 of the manifest of this release pinned in it. The hash is of the
 * exact bytes of `manifest.json`: the pinned verifier accepts the downloaded manifest only when its
 * hash is this one, so it is valid for this release and no other.
 */
export function embedManifestHash(script: string, manifestBytes: Uint8Array): string {
  const begin = script.indexOf(HASH_BEGIN);
  const end = script.indexOf(HASH_END);
  if (begin < 0 || end < begin)
    throw new InstallScriptError('the script has no embedded-manifest-hash markers');
  const block = script.slice(begin, end);
  if (!EMBEDDED_HASH.test(block))
    throw new InstallScriptError('the embedded-manifest-hash line is not in the expected form');
  const hash = sha256Hex(manifestBytes);
  return (
    script.slice(0, begin) +
    block.replace(EMBEDDED_HASH, () => `EMBEDDED_MANIFEST_SHA256='${hash}'`) +
    script.slice(end)
  );
}

export async function embedPublicKeyInFile(options: {
  readonly script: string;
  readonly publicKeyFile: string;
  /** When given, the SHA-256 of this manifest is pinned in the script too. */
  readonly manifestFile?: string | undefined;
  readonly out: string;
}): Promise<void> {
  const text = await readFile(options.script, 'utf8');
  const pem = await readFile(options.publicKeyFile, 'utf8');
  let result = embedPublicKey(text, pem);
  if (options.manifestFile !== undefined) {
    result = embedManifestHash(result, await readFile(options.manifestFile));
  }
  await writeFile(options.out, result, { mode: 0o755 });
}
