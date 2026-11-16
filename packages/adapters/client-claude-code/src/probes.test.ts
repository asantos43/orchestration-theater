// SPDX-License-Identifier: MPL-2.0
import { readdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSession,
  ContentBlock,
  ClientAdapterContract,
  Profile,
  ProbeContext,
  RolePolicy,
  SessionTransport,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROBE_FILE, SH_C_REJECT_PROBE_ID, shCRejectProbe } from './probes.js';

const profile: Profile = { client: 'claude-code', profile: 'p', id: 'claude-code/p', dir: '/x' };
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

interface Spy {
  cwds: string[];
  prompts: string[];
  cancelled: number;
  closed: number;
}

/** A session that, on demand, does what the model would do if the shell got through. */
function session(spy: Spy, cwd: string, behaviour: 'refuse' | 'create' | 'hang'): AgentSession {
  return {
    sessionId: 's',
    async prompt(blocks: readonly ContentBlock[]) {
      const first = blocks[0];
      spy.prompts.push(first?.type === 'text' ? first.text : '');
      if (behaviour === 'create') await writeFile(join(cwd, PROBE_FILE), 'x');
      if (behaviour === 'hang') await new Promise<void>(() => undefined);
      return { stopReason: 'end_turn' };
    },
    onUpdate: () => () => undefined,
    cancel() {
      spy.cancelled += 1;
      return Promise.resolve();
    },
    setConfig: () => Promise.resolve(),
    close() {
      spy.closed += 1;
      return Promise.resolve();
    },
  } as unknown as AgentSession;
}

function context(spy: Spy, behaviour: 'refuse' | 'create' | 'hang'): ProbeContext {
  const adapter = {
    openSession(_profile: Profile, _policy: RolePolicy, cwd: string): Promise<AgentSession> {
      spy.cwds.push(cwd);
      return Promise.resolve(session(spy, cwd, behaviour));
    },
  } as unknown as ClientAdapterContract;
  return { profile, adapter };
}

const transport: SessionTransport = {
  id: 'acp',
  open: () => Promise.reject(new Error('unused')),
  load: () => Promise.reject(new Error('unused')),
};

let scratchRoot: string;
let spy: Spy;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'ot-claude-probe-'));
  spy = { cwds: [], prompts: [], cancelled: 0, closed: 0 };
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe('shCRejectProbe', () => {
  it('has a stable id', () => {
    expect(shCRejectProbe({ transport, policy }).id).toBe(SH_C_REJECT_PROBE_ID);
  });

  it('passes when the file was not created, asks for sh -c, and cleans up', async () => {
    const probe = shCRejectProbe({ transport, policy, scratchRoot });
    expect(await probe.run(context(spy, 'refuse'))).toEqual({ ok: true });
    expect(spy.prompts[0]).toContain('sh -c');
    expect(spy.prompts[0]).toContain(PROBE_FILE);
    expect(spy.closed).toBe(1);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it('fails when the shell got through and the file exists, and still cleans up', async () => {
    const probe = shCRejectProbe({ transport, policy, scratchRoot });
    const result = await probe.run(context(spy, 'create'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(PROBE_FILE);
    expect(spy.closed).toBe(1);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it('cancels and fails when the turn does not end in time', async () => {
    const probe = shCRejectProbe({ transport, policy, scratchRoot, timeoutMs: 20 });
    const result = await probe.run(context(spy, 'hang'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('did not end in time');
    expect(spy.cancelled).toBe(1);
    expect(spy.closed).toBe(1);
  });

  it('runs inside its own scratch directory, never in the cwd of the caller', async () => {
    await shCRejectProbe({ transport, policy, scratchRoot }).run(context(spy, 'refuse'));
    expect(spy.cwds[0]?.startsWith(scratchRoot)).toBe(true);
  });

  it('uses the prompt it was given', async () => {
    await shCRejectProbe({ transport, policy, scratchRoot, prompt: 'custom' }).run(
      context(spy, 'refuse'),
    );
    expect(spy.prompts).toEqual(['custom']);
  });
});
