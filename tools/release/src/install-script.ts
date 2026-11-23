// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { parsePublicKey } from '@otheater/daemon/updates/verify';

/**
 * The `install.sh` of a release (Phase 10, P9): `installer/install.sh` with the public key of the
 * release between the markers `BEGIN/END embedded public key` (P5 left the word PLACEHOLDER there and
 * said that this job replaces it). The PEM goes inside single quotes, so it has to be a clean one.
 */

const EMBEDDED = /^EMBEDDED_PUBLIC_KEY='[^']*'$/m;
const BEGIN = '# BEGIN embedded public key';
const END = '# END embedded public key';

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
  if (!EMBEDDED.test(block))
    throw new InstallScriptError('the embedded-key line is not in the expected form');
  // A function as the replacement: the PEM must not be read as a replacement pattern.
  return (
    script.slice(0, begin) +
    block.replace(EMBEDDED, () => `EMBEDDED_PUBLIC_KEY='${pem}'`) +
    script.slice(end)
  );
}

export async function embedPublicKeyInFile(options: {
  readonly script: string;
  readonly publicKeyFile: string;
  readonly out: string;
}): Promise<void> {
  const text = await readFile(options.script, 'utf8');
  const pem = await readFile(options.publicKeyFile, 'utf8');
  await writeFile(options.out, embedPublicKey(text, pem), { mode: 0o755 });
}
