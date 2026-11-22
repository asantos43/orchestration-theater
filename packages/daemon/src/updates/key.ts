// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The public key the daemon checks the manifest of a release with (Phase 10, P7; docs/21). The
 * build of the executable embeds `tools/release/keys/update-public-key.pem` under
 * `__OT_UPDATE_PUBLIC_KEY__` (the `define` of esbuild, step P1). A checkout (Node and the sources)
 * reads the same file from the repository. There is no other source: not the configuration, not
 * the environment, so the key cannot be chosen by whoever can write the user's files.
 *
 * Until the owner makes the real key (N246) the file holds the word PLACEHOLDER, and the daemon
 * checks nothing with it ({@link parsePublicKey} says `placeholder`).
 */
declare const __OT_UPDATE_PUBLIC_KEY__: string | undefined;

/** The text of the embedded public key, or `undefined` when there is none to read. */
export function embeddedPublicKeyPem(): string | undefined {
  if (typeof __OT_UPDATE_PUBLIC_KEY__ === 'string') return __OT_UPDATE_PUBLIC_KEY__;
  try {
    return readFileSync(
      fileURLToPath(
        new URL('../../../../tools/release/keys/update-public-key.pem', import.meta.url),
      ),
      'utf8',
    );
  } catch {
    return undefined;
  }
}
