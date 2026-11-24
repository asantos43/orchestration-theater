// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ContentBlock,
  NormalizedUpdate,
  Profile,
  ProcessModel,
  RolePolicy,
  SharedCancelMode,
} from '@otheater/core';
import { FakeClientAdapter } from '@otheater/core/testing';
import { afterAll, beforeAll, expect } from 'vitest';
import { AcpTransport } from '../acp-transport.js';
import { NodeProcessLauncher } from './node-process-launcher.js';
import { removeDir } from './remove-dir.js';

// End to end: FakeClientAdapter + AcpTransport + the real fake agent (`@otheater/fake-agent`) as a
// child process, over ACP on its stdio. The client is the compiled `dist/cli.js`, so `pnpm build`
// has to run first (the root `pnpm check` does). The tests are in three files (`acp-e2e`,
// `acp-session-e2e`, `acp-client-e2e`) so that the workers run them side by side.

export const FAKE_AGENT_CLI = fileURLToPath(
  new URL('../../../../fake-agent/dist/cli.js', import.meta.url),
);

export const profile: Profile = {
  client: 'fake',
  profile: 'e2e',
  id: 'fake/e2e',
  dir: '/profiles/e2e',
};
export const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

export const script = (name: string, options = '', text = ''): readonly ContentBlock[] => [
  { type: 'text', text: `#script:${name}${options === '' ? '' : ` ${options}`}\n${text}` },
];

export const prompts = {
  echo: (text: string) => script('echo', '', text),
  hang: script('hang'),
  deaf: script('deaf'),
  fail: script('fail'),
  quota: script('quota-signal'),
};

/** What the rigs of a file made: `checkNothingOutlives` finds it all gone at the end. */
export const tempDirs: string[] = [];
export const allLaunchers: NodeProcessLauncher[] = [];

export interface Rig {
  readonly launcher: NodeProcessLauncher;
  readonly adapter: FakeClientAdapter;
  readonly via: AcpTransport;
  readonly cwd: string;
  readonly alive: () => number;
  readonly dispose: () => Promise<void>;
}

export async function rig(
  processModel: ProcessModel = 'process-per-session',
  sharedCancel?: SharedCancelMode,
  baseEnv: Record<string, string> = {},
): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), 'otheater-acp-e2e-'));
  tempDirs.push(cwd);
  const launcher = new NodeProcessLauncher();
  allLaunchers.push(launcher);
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv,
    adapterVersion: '1.0.0',
    command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
    processModel,
    ...(sharedCancel === undefined ? {} : { sharedCancel }),
  });
  const via = new AcpTransport({ cancelGraceMs: 300, killGraceMs: 1000, startTimeoutMs: 10_000 });
  return {
    launcher,
    adapter,
    via,
    cwd,
    alive: () => launcher.aliveGroups(),
    dispose: async () => {
      // Whatever a test left running is ended by pid: the processes of this rig only.
      await launcher.killAll();
      await removeDir(cwd);
    },
  };
}

export const text = (update: NormalizedUpdate): string =>
  update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';

/**
 * The checks around a file of these tests: the fake agent is built, and nothing outlives the file
 * (no process of any launcher, no temp folder). Each file calls it once, at its top.
 */
export function checkNothingOutlives(): void {
  beforeAll(() => {
    if (!existsSync(FAKE_AGENT_CLI)) {
      throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
    }
  });

  afterAll(async () => {
    // Nothing may outlive the tests: no process of any launcher, no temp folder.
    expect(allLaunchers.map((launcher) => launcher.aliveGroups())).toEqual(
      allLaunchers.map(() => 0),
    );
    for (const dir of tempDirs) {
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
}
