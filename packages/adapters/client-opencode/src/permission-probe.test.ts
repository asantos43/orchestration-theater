// SPDX-License-Identifier: MPL-2.0
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSession,
  ClientAdapterContract,
  ConfigValue,
  Profile,
  RolePolicy,
  SessionTransport,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPermissionProbe,
  LOOSE_PROJECT_CONFIG,
  PERMISSION_PROBE_ID,
  PROBE_FILES,
  PROBE_POLICY,
  UNCONFIGURED_PERMISSION_PROBE,
} from './permission-probe.js';

const profile: Profile = {
  client: 'opencode',
  profile: 'probe',
  id: 'opencode/probe',
  dir: '/profiles/opencode/probe',
};

interface Calls {
  opened: { policy: RolePolicy; cwd: string; via: SessionTransport; config: string }[];
  config: [string, ConfigValue][];
  prompts: string[];
  cancelled: number;
  closed: number;
}

interface Behaviour {
  /** What the turn does, given the worktree. Default: nothing is written. */
  readonly turn?: (cwd: string) => Promise<void>;
  readonly openFails?: Error;
  readonly closeFails?: boolean;
  readonly cancelFails?: boolean;
}

const via: SessionTransport = {
  id: 'acp',
  open: () => Promise.reject(new Error('not used')),
  load: () => Promise.reject(new Error('not used')),
};

function stub(behaviour: Behaviour = {}): { adapter: ClientAdapterContract; calls: Calls } {
  const calls: Calls = { opened: [], config: [], prompts: [], cancelled: 0, closed: 0 };
  const adapter = {
    async openSession(
      _profile: Profile,
      policy: RolePolicy,
      cwd: string,
      transport: SessionTransport,
    ): Promise<AgentSession> {
      calls.opened.push({
        policy,
        cwd,
        via: transport,
        config: await readFile(join(cwd, 'opencode.json'), 'utf8'),
      });
      if (behaviour.openFails !== undefined) throw behaviour.openFails;
      const session: AgentSession = {
        sessionId: 's',
        canLoad: false,
        async prompt(blocks) {
          calls.prompts.push(
            blocks.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          );
          await behaviour.turn?.(cwd);
          return { stopReason: 'end_turn' };
        },
        onUpdate: () => ({ dispose: () => undefined }),
        cancel() {
          calls.cancelled += 1;
          return behaviour.cancelFails === true
            ? Promise.reject(new Error('x'))
            : Promise.resolve();
        },
        setConfig(id, value) {
          calls.config.push([id, value]);
          return Promise.resolve();
        },
        close() {
          calls.closed += 1;
          return behaviour.closeFails === true ? Promise.reject(new Error('x')) : Promise.resolve();
        },
      };
      return session;
    },
  } as unknown as ClientAdapterContract;
  return { adapter, calls };
}

describe('permission probe', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'otheater-opencode-probe-test-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const probeOf = (options: Partial<Parameters<typeof createPermissionProbe>[0]> = {}) =>
    createPermissionProbe({ via, scratchRoot: scratch, timeoutMs: 2_000, ...options });

  it('has the id of the conformance report, and a loose project config that allows everything', () => {
    expect(probeOf().id).toBe(PERMISSION_PROBE_ID);
    expect(LOOSE_PROJECT_CONFIG).toMatchObject({
      permission: { '*': 'allow', edit: 'allow', bash: 'allow' },
    });
  });

  it('passes when neither file shows up, having opened the session in a worktree with the loose config', async () => {
    const { adapter, calls } = stub();
    const result = await probeOf().run({ profile, adapter });
    expect(result.ok).toBe(true);
    expect(calls.opened).toHaveLength(1);
    expect(JSON.parse(calls.opened[0]?.config ?? '')).toEqual(LOOSE_PROJECT_CONFIG);
    expect(calls.opened[0]?.policy).toEqual(PROBE_POLICY);
    expect(calls.opened[0]?.via).toBe(via);
    expect(calls.prompts).toHaveLength(1);
    expect(calls.prompts[0]).toContain(PROBE_FILES[0]);
    expect(calls.prompts[0]).toContain(PROBE_FILES[1]);
  });

  it('the probe policy is a reader: no edits, no shell, nothing to ask about', () => {
    expect(PROBE_POLICY.nativeTools).not.toContain('edit');
    expect(PROBE_POLICY.nativeTools).not.toContain('write');
    expect(PROBE_POLICY.nativeShell).toBe('none');
    expect(PROBE_POLICY.bypass).toBe('forbidden');
  });

  it('fails, naming the file, when the editing tool wrote one', async () => {
    const { adapter } = stub({
      turn: (cwd) => writeFile(join(cwd, PROBE_FILES[0]), 'ok'),
    });
    const result = await probeOf().run({ profile, adapter });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(PROBE_FILES[0]);
    expect(result.detail).not.toContain(PROBE_FILES[1]);
  });

  it('fails when the shell wrote one, and names both when both were written', async () => {
    const shell = stub({ turn: (cwd) => writeFile(join(cwd, PROBE_FILES[1]), '') });
    const one = await probeOf().run({ profile, adapter: shell.adapter });
    expect(one.ok).toBe(false);
    expect(one.detail).toContain(PROBE_FILES[1]);
    const both = stub({
      turn: async (cwd) => {
        await writeFile(join(cwd, PROBE_FILES[0]), '');
        await writeFile(join(cwd, PROBE_FILES[1]), '');
      },
    });
    const two = await probeOf().run({ profile, adapter: both.adapter });
    expect(two.detail).toContain(PROBE_FILES[0]);
    expect(two.detail).toContain(PROBE_FILES[1]);
  });

  it('selects the model before the prompt when one was given', async () => {
    const { adapter, calls } = stub();
    await probeOf({ model: 'cheap/model' }).run({ profile, adapter });
    expect(calls.config).toEqual([['model', 'cheap/model']]);
    const without = stub();
    await probeOf().run({ profile, adapter: without.adapter });
    expect(without.calls.config).toEqual([]);
  });

  it('uses the policy it was given instead of its own', async () => {
    const policy: RolePolicy = { ...PROBE_POLICY, nativeTools: ['read'] };
    const { adapter, calls } = stub();
    await probeOf({ policy }).run({ profile, adapter });
    expect(calls.opened[0]?.policy).toBe(policy);
  });

  it('a turn that does not end is a failure, not a pass: it cancels, closes and cleans up', async () => {
    const { adapter, calls } = stub({ turn: () => new Promise<void>(() => undefined) });
    const result = await probeOf({ timeoutMs: 30 }).run({ profile, adapter });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not end in time/);
    expect(calls.cancelled).toBe(1);
    expect(calls.closed).toBe(1);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('does not cancel a turn that ended, but always closes the session', async () => {
    const { adapter, calls } = stub();
    await probeOf().run({ profile, adapter });
    expect(calls.cancelled).toBe(0);
    expect(calls.closed).toBe(1);
  });

  it('removes the scratch worktree, also when the files were written', async () => {
    const { adapter, calls } = stub({ turn: (cwd) => writeFile(join(cwd, PROBE_FILES[0]), 'x') });
    await probeOf().run({ profile, adapter });
    await expect(access(calls.opened[0]?.cwd ?? scratch + '/missing')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('a session that does not open rejects, and the scratch worktree is gone', async () => {
    const { adapter } = stub({ openFails: new Error('no client') });
    await expect(probeOf().run({ profile, adapter })).rejects.toThrow('no client');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('a close that fails is not hidden behind the result, and does not keep the directory', async () => {
    const { adapter } = stub({ closeFails: true, cancelFails: true });
    const result = await probeOf().run({ profile, adapter });
    expect(result.ok).toBe(true);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('every run gets its own worktree', async () => {
    const { adapter, calls } = stub();
    const probe = probeOf();
    await probe.run({ profile, adapter });
    await probe.run({ profile, adapter });
    expect(new Set(calls.opened.map((entry) => entry.cwd)).size).toBe(2);
  });

  describe('UNCONFIGURED_PERMISSION_PROBE', () => {
    it('fails: a check that was not run is never a passed one', async () => {
      const { adapter } = stub();
      const result = await UNCONFIGURED_PERMISSION_PROBE.run({ profile, adapter });
      expect(UNCONFIGURED_PERMISSION_PROBE.id).toBe(PERMISSION_PROBE_ID);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/not run/);
    });
  });
});
