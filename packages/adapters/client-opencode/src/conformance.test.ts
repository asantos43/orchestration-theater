// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_POLICY_FIELDS,
  type AgentSession,
  type ContentBlock,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import {
  describeAgentSessionConformance,
  describeClientAdapterConformance,
  type AgentSessionHarness,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { afterAll, beforeAll, expect } from 'vitest';
import { opencodeAdapterVersion, OpenCodeAdapter } from './opencode-adapter.js';
import { AcpTestTransport } from './testing/acp-test-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

// The conformance suites of the SDK over `OpenCodeAdapter`, with no real OpenCode:
//  (a) in memory: the scripts of the fake agent run by `FakeSessionTransport`;
//  (b) end to end: the fake agent (`@otheater/fake-agent`) as a child process over ACP, through the
//      copy of the ACP transport in `src/testing`. It runs the compiled `dist/cli.js`, so
//      `pnpm build` has to run first (the root `pnpm check` does).
// Both use `pool.opencode.process_model = per_session`: the base opens sessions only in the
// process-per-session model until the pool (P8) exists.

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const script = (name: string, options = '', text = ''): readonly ContentBlock[] => [
  { type: 'text', text: `#script:${name}${options === '' ? '' : ` ${options}`}\n${text}` },
];

const prompts = {
  echo: (text: string) => script('echo', '', text),
  hang: script('hang'),
  fail: script('fail'),
  quota: script('quota-signal'),
};

const tempDirs: string[] = [];
const allLaunchers: NodeProcessLauncher[] = [];

interface Base {
  readonly root: string;
  readonly cwd: string;
  readonly profile: Profile;
}

async function base(): Promise<Base> {
  const root = await mkdtemp(join(tmpdir(), 'otheater-opencode-conformance-'));
  tempDirs.push(root);
  return {
    root,
    cwd: join(root, 'work'),
    profile: {
      client: 'opencode',
      profile: 'conformance',
      id: 'opencode/conformance',
      dir: join(root, 'profile'),
    },
  };
}

const remove = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

async function makeCwd(b: Base): Promise<void> {
  await mkdir(b.cwd, { recursive: true });
}

interface Memory {
  readonly b: Base;
  readonly adapter: OpenCodeAdapter;
  readonly launcher: FakeProcessLauncher;
  readonly via: FakeSessionTransport;
  readonly dispose: () => Promise<void>;
}

async function memory(): Promise<Memory> {
  const b = await base();
  await makeCwd(b);
  const launcher = new FakeProcessLauncher();
  const via = new FakeSessionTransport({ id: 'acp' });
  const adapter = new OpenCodeAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: opencodeAdapterVersion(),
    processModel: 'per_session',
    sandbox: { fields: ROLE_POLICY_FIELDS },
    profileDir: () => b.profile.dir,
    permissionProbe: { via, scratchRoot: b.root, timeoutMs: 10_000 },
  });
  return {
    b,
    adapter,
    launcher,
    via,
    dispose: async () => {
      await Promise.all(launcher.running.map((process) => process.killTree()));
      await remove(b.root);
    },
  };
}

interface Wire {
  readonly b: Base;
  readonly adapter: OpenCodeAdapter;
  readonly launcher: NodeProcessLauncher;
  readonly via: AcpTestTransport;
  readonly dispose: () => Promise<void>;
}

async function wire(): Promise<Wire> {
  const b = await base();
  await makeCwd(b);
  const launcher = new NodeProcessLauncher();
  allLaunchers.push(launcher);
  const via = new AcpTestTransport({
    cancelGraceMs: 300,
    killGraceMs: 1000,
    startTimeoutMs: 10_000,
  });
  const adapter = new OpenCodeAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: opencodeAdapterVersion(),
    processModel: 'per_session',
    sandbox: { fields: ROLE_POLICY_FIELDS },
    command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
    profileDir: () => b.profile.dir,
    permissionProbe: { via, scratchRoot: b.root, timeoutMs: 20_000 },
  });
  return {
    b,
    adapter,
    launcher,
    via,
    dispose: async () => {
      // Whatever a test left running is ended by pid: the processes of this rig only.
      await launcher.killAll();
      await remove(b.root);
    },
  };
}

beforeAll(() => {
  if (!existsSync(FAKE_AGENT_CLI)) {
    throw new Error(`${FAKE_AGENT_CLI} does not exist: run "pnpm build" before the tests`);
  }
});

afterAll(async () => {
  // Nothing may outlive the tests: no process of any launcher, no temp folder.
  expect(allLaunchers.map((launcher) => launcher.aliveGroups())).toEqual(allLaunchers.map(() => 0));
  for (const dir of tempDirs) {
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describeClientAdapterConformance('OpenCodeAdapter + FakeSessionTransport (in memory)', async () => {
  const r = await memory();
  const harness: ClientAdapterHarness = {
    adapter: r.adapter,
    via: r.via,
    profile: r.b.profile,
    policy,
    cwd: r.b.cwd,
    prompts,
    permission: {
      prompt: script('edit-file', '{"path":"out.txt"}'),
      granted: () => r.via.edits.length > 0,
    },
    processesAlive: () => r.launcher.running.length,
    unknownSessionId: 'no-such-conversation',
    dispose: r.dispose,
  };
  return harness;
});

describeClientAdapterConformance('OpenCodeAdapter + AcpTestTransport + fake-agent', async () => {
  const r = await wire();
  const edited = join(r.b.cwd, 'out.txt');
  const harness: ClientAdapterHarness = {
    adapter: r.adapter,
    via: r.via,
    profile: r.b.profile,
    policy,
    cwd: r.b.cwd,
    prompts,
    permission: {
      prompt: script('edit-file', '{"path":"out.txt"}'),
      granted: () => existsSync(edited),
    },
    processesAlive: () => r.launcher.aliveGroups(),
    dispose: r.dispose,
  };
  return harness;
});

describeAgentSessionConformance('OpenCodeAdapter session (in memory)', async () => {
  const r = await memory();
  let current: AgentSession = await r.adapter.openSession(r.b.profile, policy, r.b.cwd, r.via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: () => r.launcher.running.length,
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await r.adapter.loadSession(r.b.profile, policy, r.b.cwd, current.sessionId, r.via);
      return current;
    },
    reloadUnknown: () =>
      r.adapter.loadSession(r.b.profile, policy, r.b.cwd, 'no-such-conversation', r.via),
    dispose: r.dispose,
  };
  return harness;
});

describeAgentSessionConformance('OpenCodeAdapter session + fake-agent over ACP', async () => {
  const r = await wire();
  let current: AgentSession = await r.adapter.openSession(r.b.profile, policy, r.b.cwd, r.via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: () => r.launcher.aliveGroups(),
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await r.adapter.loadSession(r.b.profile, policy, r.b.cwd, current.sessionId, r.via);
      return current;
    },
    crash: () => r.launcher.killAll(),
    dispose: r.dispose,
  };
  return harness;
});
