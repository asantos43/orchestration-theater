// SPDX-License-Identifier: MPL-2.0
import type { ContentBlock, Profile, RolePolicy } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeProcessLauncher,
  FakeSessionTransport,
  type FakeLaunchedProcess,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import {
  describeAgentSessionConformance,
  describeClientAdapterConformance,
  realClientFlags,
  type AgentSessionHarness,
  type ClientAdapterHarness,
} from '../index.js';

// The fakes of `@otheater/core/testing` (`FakeClientAdapter`, `FakeSessionTransport`,
// `FakeProcessLauncher`) must pass the client suites: that is this step's test. The suites are
// also run against the real fake agent, over ACP, in `@otheater/adapter-session-acp`.

const profile: Profile = { client: 'fake', profile: 'p', id: 'fake/p', dir: '/profiles/fake/p' };
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

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
  const via = new FakeSessionTransport();
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: [] },
  });
  const alive = (): number => launcher.running.length;
  return { launcher, via, adapter, alive };
}

describeAgentSessionConformance('FakeSessionTransport', async () => {
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

describeClientAdapterConformance('FakeClientAdapter + FakeSessionTransport', () => {
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

describe('the real-client switches', () => {
  it('are off unless the environment sets them to 1', () => {
    const flags = realClientFlags();
    expect(flags.clients).toBe(process.env.OT_TEST_REAL_CLIENTS === '1');
    expect(flags.prompts).toBe(process.env.OT_TEST_REAL_PROMPTS === '1');
  });
});
