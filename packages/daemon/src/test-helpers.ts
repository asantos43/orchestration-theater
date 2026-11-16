// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile, RolePolicy } from '@otheater/core';

/** A temporary data directory removed by `dispose()`. Never the real one. */
export async function makeTempDataDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-daemon-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** A profile and a policy of the fake client, for the tests of the execution of sessions. */
export const TEST_PROFILE: Profile = {
  client: 'fake',
  profile: 'one',
  id: 'fake/one',
  dir: '/profiles/fake/one',
};

export const TEST_POLICY: RolePolicy = {
  nativeTools: ['read', 'search', 'edit', 'write'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};
