// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOTheaterError,
  QuotaExhausted,
  Transient,
  type AgentSession,
  type ContentBlock,
  type NormalizedUpdate,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeClientAdapter } from '@otheater/core/testing';
import {
  describeAgentSessionConformance,
  describeClientAdapterConformance,
  type AgentSessionHarness,
  type ClientAdapterHarness,
} from '@otheater/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AcpTransport } from './acp-transport.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';
import { removeDir } from './testing/remove-dir.js';

// End to end: FakeClientAdapter + AcpTransport + the real fake agent (`@otheater/fake-agent`) as a
// child process, over ACP on its stdio. The client is the compiled `dist/cli.js`, so `pnpm build`
// has to run first (the root `pnpm check` does).

const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

const profile: Profile = { client: 'fake', profile: 'e2e', id: 'fake/e2e', dir: '/profiles/e2e' };
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

interface Rig {
  readonly launcher: NodeProcessLauncher;
  readonly adapter: FakeClientAdapter;
  readonly via: AcpTransport;
  readonly cwd: string;
  readonly alive: () => number;
  readonly dispose: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), 'otheater-acp-e2e-'));
  tempDirs.push(cwd);
  const launcher = new NodeProcessLauncher();
  allLaunchers.push(launcher);
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: {},
    adapterVersion: '1.0.0',
    command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
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

const text = (update: NormalizedUpdate): string =>
  update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';

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

describeAgentSessionConformance('AcpTransport + fake-agent', async () => {
  const r = await rig();
  let current: AgentSession = await r.adapter.openSession(profile, policy, r.cwd, r.via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: r.alive,
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await r.adapter.loadSession(profile, policy, r.cwd, current.sessionId, r.via);
      return current;
    },
    crash: () => r.launcher.killAll(),
    dispose: r.dispose,
  };
  return harness;
});

describeClientAdapterConformance('FakeClientAdapter + AcpTransport + fake-agent', async () => {
  const r = await rig();
  const edited = join(r.cwd, 'out.txt');
  const harness: ClientAdapterHarness = {
    adapter: r.adapter,
    via: r.via,
    profile,
    policy,
    cwd: r.cwd,
    prompts,
    permission: {
      prompt: script('edit-file', '{"path":"out.txt"}'),
      granted: () => existsSync(edited),
    },
    processesAlive: r.alive,
    dispose: r.dispose,
  };
  return harness;
});

describe('the scripts of the fake agent, end to end', () => {
  async function opened(): Promise<{ r: Rig; session: AgentSession; updates: NormalizedUpdate[] }> {
    const r = await rig();
    cleanup.push(r);
    const session = await r.adapter.openSession(profile, policy, r.cwd, r.via);
    const updates: NormalizedUpdate[] = [];
    session.onUpdate((update) => updates.push(update));
    return { r, session, updates };
  }
  const cleanup: Rig[] = [];
  afterEach(async () => {
    for (const r of cleanup.splice(0)) await r.dispose();
  });

  it('echo: the text comes back as message chunks, then the turn ends', async () => {
    const { r, session, updates } = await opened();
    const outcome = await session.prompt(prompts.echo('one two three'));
    expect(outcome.stopReason).toBe('end_turn');
    expect(updates.map(text).join('')).toContain('one two three');
    await session.close();
    expect(r.alive()).toBe(0);
  });

  it('tool-call: a tool call and its update reach the listener, normalized', async () => {
    const { session, updates } = await opened();
    await session.prompt(script('tool-call'));
    const call = updates.find((update) => update.kind === 'tool_call');
    expect(call).toMatchObject({ kind: 'tool_call', status: expect.any(String) as unknown });
    expect(updates.some((update) => update.kind === 'tool_call_update')).toBe(true);
    await session.close();
  });

  it('edit-file: the permission request is answered by the policy and the file is not written', async () => {
    const { r, session } = await opened();
    const outcome = await session.prompt(script('edit-file', '{"path":"out.txt"}'));
    expect(['end_turn', 'cancelled']).toContain(outcome.stopReason);
    expect(existsSync(join(r.cwd, 'out.txt'))).toBe(false);
    await session.close();
  });

  it('fail: a scripted failure is a typed error, not a protocol error', async () => {
    const { session } = await opened();
    const error = await session.prompt(prompts.fail).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Transient);
    expect(isOTheaterError(error)).toBe(true);
    await session.close();
  });

  it('hang: cancel by timeout ends the turn as cancelled and leaves no orphan', async () => {
    const { r, session } = await opened();
    const running = session.prompt(prompts.hang);
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, 300);
    });
    const first = await Promise.race([running, timer]);
    expect(first).toBe('timeout');
    await session.cancel();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(r.alive()).toBe(0);
  });

  it('quota-signal: the exhausted quota becomes QuotaExhausted, with the signals dropped quietly', async () => {
    const { session } = await opened();
    const error = await session.prompt(prompts.quota).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QuotaExhausted);
    await session.close();
  });
});
