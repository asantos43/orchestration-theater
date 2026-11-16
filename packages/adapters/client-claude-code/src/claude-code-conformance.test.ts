// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Profile, RolePolicy } from '@otheater/core';
import {
  FakeProcessLauncher,
  FakeSessionTransport,
  type FakeLaunchedProcess,
} from '@otheater/core/testing';
import {
  describeAgentSessionConformance,
  describeClientAdapterConformance,
  type AgentSessionHarness,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';

// The conformance suites of the SDK against this adapter. The client below it is the fake of
// `@otheater/core/testing` (`FakeSessionTransport` + `FakeProcessLauncher`): an adapter cannot
// import `@otheater/adapter-session-acp` to talk ACP to the `fake-agent` (rule `adapter-isolation`),
// so the translation is exercised through the base class, with the scripts the fake transport
// plays. What the real client does is in `claude-code.real.test.ts`, behind OT_TEST_REAL_CLIENTS.

const root = mkdtempSync(join(tmpdir(), 'ot-claude-conformance-'));
const profile: Profile = {
  client: 'claude-code',
  profile: 'conformance',
  id: 'claude-code/conformance',
  dir: join(root, 'profile'),
};
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const script = (name: string, text = ''): readonly ContentBlock[] => [
  { type: 'text', text: `#script:${name}\n${text}` },
];

const prompts = {
  echo: (text: string) => script('echo', text),
  hang: script('hang'),
  fail: script('fail'),
  quota: script('quota-signal'),
};

function build() {
  const launcher = new FakeProcessLauncher();
  const via = new FakeSessionTransport({ id: 'acp' });
  const adapter = new ClaudeCodeAdapter({
    launcher,
    baseEnv: {},
    // `writeScope` and `network` have no layer in the client: the conformance run assumes a sandbox.
    sandbox: { fields: ['writeScope', 'network'] },
    command: { cmd: 'fake-claude-agent-acp', args: [] },
  });
  const alive = (): number => launcher.running.length;
  return { launcher, via, adapter, alive };
}

describeAgentSessionConformance('ClaudeCodeAdapter + FakeSessionTransport', async () => {
  const { adapter, via, launcher, alive } = build();
  let current = await adapter.openSession(profile, policy, '/work', via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: alive,
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await adapter.loadSession(profile, policy, '/work', current.sessionId, via);
      return current;
    },
    reloadUnknown: () => adapter.loadSession(profile, policy, '/work', 'unknown', via),
    crash: () => {
      const process: FakeLaunchedProcess | undefined = launcher.running[0];
      process?.exit(1, null);
      return Promise.resolve();
    },
    dispose: async () => {
      await Promise.all(launcher.running.map((process) => process.killTree()));
    },
  };
  return harness;
});

describeClientAdapterConformance('ClaudeCodeAdapter + FakeSessionTransport', () => {
  const { adapter, via, launcher, alive } = build();
  const harness: ClientAdapterHarness = {
    adapter,
    via,
    profile,
    policy,
    cwd: '/work',
    prompts,
    permission: {
      prompt: script('edit-file', '{"path":"out.txt"}'),
      granted: () => via.edits.length > 0,
    },
    processesAlive: alive,
    unknownSessionId: 'unknown',
    dispose: async () => {
      await Promise.all(launcher.running.map((process) => process.killTree()));
    },
  };
  return harness;
});

describe('what the conformance suites cannot see', () => {
  it('the adapter never spawns a real process in these tests', () => {
    const { launcher } = build();
    expect(launcher.launched).toHaveLength(0);
  });
});
