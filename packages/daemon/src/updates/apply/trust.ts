// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assetFor, parseManifest } from '../manifest.js';
import { embeddedPublicKeyPem } from '../key.js';
import { updatePlatform } from '../install.js';
import { parsePublicKey, sha256Hex, verifySignature, type PublicKeyResult } from '../verify.js';
import type { UpdateJournal } from './journal.js';
import type { InstallLayout } from './layout.js';

/**
 * The trust in a journal (Phase 11, P8a). `update-state.json` sits beside the executable, in a
 * folder the user can write, and whoever reads it acts on it: the applier walks its steps, the next
 * `ot` that starts finishes or undoes the swap it describes, and the daemon that comes back trusts
 * its `to`, `sha256` and `backup`. A file that anyone able to write there could forge would then
 * steer a swap (a target the manifest never signed, a backup folder of its choice).
 *
 * The minimum safe measure [proposta, decided in P8a; the owner can ask for more]: a journal that
 * still asks for something to be done (any step that is not final) must be backed by a proof the
 * daemon left beside the new executable when it wrote the journal: the signed manifest and its
 * signature, copied into `staging/`. The journal carries the SHA-256 of that manifest. The proof is
 * accepted when the signature checks with the public key of this build (the same key as for an
 * update, never one from a file the user can write), the manifest names the journal's `to`, and the
 * executable of this platform in it has the journal's `sha256`. What the journal says to do is then
 * what a manifest the owner signed says; the other fields are confined where they are used
 * (`exe` to the folder of the journal, `backup` to the backup folder of the configuration).
 *
 * What this does not cover [N]: an attacker who can write the folder can still delete the journal
 * or the proof (a denial of the swap, not a forged one), and can replay an older manifest that is
 * validly signed together with its own executable. The final steps (`committed`, `rolled_back`,
 * `failed`) ask for nothing to be done, so they are not checked (the proof is removed on commit).
 */

export type JournalTrust = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export const PROOF_MANIFEST = 'manifest.json';
export const PROOF_SIGNATURE = 'manifest.json.sig';

export interface TrustInput {
  readonly layout: InstallLayout;
  readonly journal: UpdateJournal;
  /** The public key of this build. */
  readonly key: PublicKeyResult;
  /** The platform id of the executables (`linux-x64`). */
  readonly platform: string;
}

const no = (detail: string): JournalTrust => ({ ok: false, detail });

export async function checkJournalTrust(input: TrustInput): Promise<JournalTrust> {
  const { layout, journal, key } = input;
  if (key.state !== 'valid') return no(`this build has no usable public key (${key.state})`);
  let bytes: Buffer;
  let signature: string;
  try {
    bytes = await readFile(join(layout.stagingDir, PROOF_MANIFEST));
    signature = await readFile(join(layout.stagingDir, PROOF_SIGNATURE), 'utf8');
  } catch {
    return no('the signed manifest that backs the journal is not there');
  }
  if (sha256Hex(bytes) !== journal.manifestSha256) {
    return no('the manifest beside the journal is not the one it names');
  }
  if (!verifySignature(bytes, signature, key.key)) {
    return no('the manifest beside the journal is not signed by the release key');
  }
  let manifest;
  try {
    manifest = parseManifest(bytes);
  } catch {
    return no('the manifest beside the journal cannot be read');
  }
  if (manifest.version !== journal.to) return no('the manifest is of another version');
  const asset = assetFor(manifest, input.platform);
  if (asset?.sha256 !== journal.sha256) {
    return no('the executable of the journal is not the one the manifest signs');
  }
  return { ok: true };
}

/** The key and the platform of this build: what the real applier and the recovery check the journal with. */
export function ownTrust(): { readonly key: PublicKeyResult; readonly platform: string } {
  return { key: parsePublicKey(embeddedPublicKeyPem()), platform: updatePlatform() };
}
