// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ClientAdapter,
  ProfileRef,
  RolePolicy,
  SessionConfigOption,
  SessionTransport,
} from '@otheater/core';
import { profileDirOf, type DataPaths } from './paths.js';

/** Name of the empty directory (inside the data directory) the catalog sessions run in. */
export const CATALOG_PROBE_DIR = 'catalog-probe';

/**
 * The policy of a session opened only to read its `configOptions`: the role of a reader. No
 * prompt is ever sent, so no tool runs; the policy is there because `openSession` takes one, and
 * it asks for the least a session can have (reads, no shell, no MCP, nothing written outside the
 * worktree, no network). The session is opened with `purpose: 'catalog-probe'`: with
 * `security.catalog_probe: allow` the adapter exempts it from `security.unenforced`, and the
 * session it hands back never runs a prompt.
 */
export const CATALOG_PROBE_POLICY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

export interface SessionConfigReaderOptions {
  /** The client whose catalog is read. A function, because the adapter is built with the reader. */
  readonly adapter: () => ClientAdapter;
  /** The transport the session goes through (the veto of modes is in the adapter, not in the transport). */
  readonly via: (adapter: ClientAdapter) => SessionTransport;
  readonly paths: Pick<DataPaths, 'dataDir' | 'profiles'>;
  /** Default {@link CATALOG_PROBE_POLICY}. */
  readonly policy?: RolePolicy;
}

/**
 * The production reader of a model catalog (architecture 5.2): opens a session of the profile
 * without a prompt, takes the `configOptions` the client announced for it and closes the session.
 * The directory is `<data>/catalog-probe`, empty, so the client has nothing of a project to read.
 * It rejects when the session does not open (the catalog decides what that means: Claude falls
 * back to its reserve list, Codex has none). The session is closed whatever happens.
 */
export function sessionConfigReader(
  options: SessionConfigReaderOptions,
): (profile: ProfileRef) => Promise<readonly SessionConfigOption[]> {
  return async (ref) => {
    const adapter = options.adapter();
    const profile = {
      client: ref.client,
      profile: ref.profile,
      id: `${ref.client}/${ref.profile}`,
      dir: profileDirOf(options.paths, ref),
    };
    const cwd = join(options.paths.dataDir, CATALOG_PROBE_DIR);
    await mkdir(cwd, { recursive: true });
    const session = await adapter.openSession(
      profile,
      options.policy ?? CATALOG_PROBE_POLICY,
      cwd,
      options.via(adapter),
      { purpose: 'catalog-probe' },
    );
    try {
      return session.configOptions;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}
