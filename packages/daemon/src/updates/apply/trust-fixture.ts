// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRelease, type ReleaseSpec, type TestKeys } from '../release-fixture.js';
import { sha256Hex } from '../verify.js';
import type { InstallLayout } from './layout.js';
import { PROOF_MANIFEST, PROOF_SIGNATURE } from './trust.js';

/**
 * Test support for the trust in a journal (Phase 11, P8a): writes beside the executable the proof
 * the daemon leaves there (the signed manifest and its signature, made with a key of the test) and
 * returns the SHA-256 the journal must carry for it.
 */
export async function writeProof(
  layout: InstallLayout,
  keys: TestKeys,
  spec: ReleaseSpec,
): Promise<string> {
  const release = buildRelease(keys, spec);
  await mkdir(layout.stagingDir, { recursive: true });
  await writeFile(join(layout.stagingDir, PROOF_MANIFEST), release.manifestBytes);
  await writeFile(join(layout.stagingDir, PROOF_SIGNATURE), release.signature);
  return sha256Hex(release.manifestBytes);
}
