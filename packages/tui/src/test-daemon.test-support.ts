// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDaemonDirectory } from '@otheater/client/node';
import {
  createSilentLogger,
  parseConfig,
  startDaemon,
  type ComposeOverrides,
  type DaemonHandle,
} from '@otheater/daemon';
import { directoryConnector, type DaemonConnector } from './daemon-connection.js';

/**
 * A real daemon in this process, for the tests of the TUI (N57: nothing real runs). The store, the
 * clock and the vault are the in-memory fakes, which the test file builds and passes in (only
 * `*.test.ts(x)` files may import `@otheater/core/testing`); no client is found (the fake-agent
 * only enters when a test starts a play, which these tests do not). The API listens on 127.0.0.1
 * in a temporary data folder, and the TUI finds it as it would the real one.
 */
export interface TuiTestDaemon {
  readonly dataDir: string;
  readonly daemon: DaemonHandle;
  /** What the TUI connects through: discovery in `dataDir`. */
  readonly connector: DaemonConnector;
  dispose(): Promise<void>;
}

export async function startTuiTestDaemon(
  overrides: ComposeOverrides,
  configYaml = '',
): Promise<TuiTestDaemon> {
  const dataDir = await mkdtemp(join(tmpdir(), 'otheater-tui-'));
  try {
    const daemon = await startDaemon({
      dataDir,
      clientSearch: { env: { PATH: '' }, findExecutable: () => undefined },
      config: parseConfig(`backup:\n  when: manual\n${configYaml}`),
      overrides,
      logger: createSilentLogger(),
      version: '0.0.0-test',
    });
    return {
      dataDir,
      daemon,
      connector: directoryConnector(createNodeDaemonDirectory({ dataDir })),
      dispose: async () => {
        await daemon.stop();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
