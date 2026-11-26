// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDaemonDirectory } from '@otheater/client/node';
import { AdapterUnavailable, type Sandbox } from '@otheater/core';
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

/**
 * N334 [proposta]: whether the daemon of the test has layer 3 does not depend on the machine (a
 * Linux with bubblewrap has it, a Windows has not). By default it has one (a sandbox that says it is
 * available and is never used: no client runs), so the assistant does not ask about
 * `security.unenforced`; a test about the question or about the fixed row asks for `layer3: 'missing'`
 * (the sandbox is simulated as unavailable).
 */
export interface TuiTestDaemonOptions {
  readonly layer3?: 'present' | 'missing';
}

/** A sandbox that is available and is not used by any test of the TUI. */
function availableSandbox(): Sandbox {
  return {
    id: 'fake-sandbox',
    implements: { port: 'Sandbox', range: '^0.1.0' },
    capabilities: () => ({ fields: ['writeScope', 'network'] }),
    available: () => Promise.resolve({ ok: true }),
    wrap: () => Promise.reject(new AdapterUnavailable('not used here')),
    close: () => Promise.resolve(),
  };
}

export async function startTuiTestDaemon(
  overrides: ComposeOverrides,
  configYaml = '',
  options: TuiTestDaemonOptions = {},
): Promise<TuiTestDaemon> {
  const dataDir = await mkdtemp(join(tmpdir(), 'otheater-tui-'));
  try {
    const daemon = await startDaemon({
      dataDir,
      clientSearch: { env: { PATH: '' }, findExecutable: () => undefined },
      config: parseConfig(`backup:\n  when: manual\n${configYaml}`),
      overrides: {
        sandbox: options.layer3 === 'missing' ? 'none' : availableSandbox(),
        ...overrides,
      },
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
