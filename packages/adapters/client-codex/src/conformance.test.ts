// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, ProcessModel, Profile, RolePolicy } from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import {
  describeAgentSessionConformance,
  describeClientAdapterConformance,
  type AgentSessionHarness,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { afterAll } from 'vitest';
import { CodexAdapter } from './codex-adapter.js';

// The suites of `@otheater/sdk` against the Codex adapter, over the in-memory fakes of
// `@otheater/core/testing` (the `adapter-isolation` rule keeps this package from importing
// `@otheater/adapter-session-acp`, so the fake agent over ACP is not used here). The `quota`
// prompt is left out of the session harness: the fake signals a quota in its own shape, and the
// Codex shape is covered by `normalize.test.ts`. Nothing here starts a real client.

// `prepareProfile` writes `config.toml` for real, so the profile directory is a scratch one.
const dir = mkdtempSync(join(tmpdir(), 'ot-codex-conformance-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const profile: Profile = { client: 'codex', profile: 'p', id: 'codex/p', dir };
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
};

function build(processModel: ProcessModel) {
  const launcher = new FakeProcessLauncher();
  const adapter = new CodexAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '2.6.0',
    processModel,
    // Layer 3 as the daemon will have it; without it the policy is short, by design.
    sandbox: { fields: ['nativeTools', 'nativeShell', 'network'] },
    unenforced: 'allow',
    readSessionMode: () => Promise.resolve('workspace-write'),
  });
  const fake = new FakeSessionTransport();
  const via = adapter.guardTransport(fake);
  return { adapter, via, fake, launcher, alive: () => launcher.running.length };
}

/** The suites run in both process models: `multi-session` is the default of Codex (Phase 0), the other is the option. */
for (const processModel of ['multi-session', 'process-per-session'] as const) {
  const label = `CodexAdapter + FakeSessionTransport, ${processModel}`;

  describeAgentSessionConformance(label, async () => {
    const { adapter, via, launcher, alive } = build(processModel);
    let current = await adapter.openSession(profile, policy, '/work', via);
    const harness: AgentSessionHarness = {
      get session() {
        return current;
      },
      prompts,
      processesAlive: alive,
      rootProcessesAlive: alive,
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
      ...(processModel === 'multi-session'
        ? { sibling: () => adapter.openSession(profile, policy, '/work', via) }
        : {}),
      crash: () => {
        for (const process of launcher.running) process.exit(1, null);
        return Promise.resolve();
      },
      dispose: async () => {
        await Promise.all(launcher.running.map((process) => process.killTree()));
      },
    };
    return harness;
  });

  describeClientAdapterConformance(label, () => {
    const { adapter, via, fake, launcher, alive } = build(processModel);
    const harness: ClientAdapterHarness = {
      adapter,
      via,
      profile,
      policy,
      cwd: '/work',
      prompts,
      permission: {
        prompt: script('edit-file', '{"path":"out.txt"}'),
        granted: () => fake.edits.length > 0,
      },
      processesAlive: alive,
      rootProcessesAlive: alive,
      crash: () => {
        for (const process of launcher.running) process.exit(1, null);
        return Promise.resolve();
      },
      unknownSessionId: 'unknown',
      dispose: async () => {
        await Promise.all(launcher.running.map((process) => process.killTree()));
      },
    };
    return harness;
  });
}
