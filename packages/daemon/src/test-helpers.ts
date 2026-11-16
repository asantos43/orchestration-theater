// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temporary data directory removed by `dispose()`. Never the real one. */
export async function makeTempDataDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-daemon-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}
