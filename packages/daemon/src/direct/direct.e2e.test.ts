// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- the answers of the API are read as loose JSON */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { itWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { dataPaths } from '../paths.js';

/**
 * The direct session with an Actor (Phase 7, P19; N44, N190; architecture 5.20), end to end with the
 * fake agent and the real REST routes. Nothing real runs (N57): temporary folders, loopback, a fake
 * clock, a fake code host; no test reads a credential. The fake agent plays `echo` unless a message
 * names another script (`#script:edit-file {...}`), and announces its command while the session is
 * set up (`FAKE_AGENT_UPDATES_ON_CONFIG`).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const run = promisify(execFile);
const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;

/** The registry of the two profiles and the lists of the roles. */
function rolesConfig(extra = ''): string {
  const registry = ['one', 'two']
    .map(
      (profile) =>
        `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
    )
    .join('');
  const roles = ROLES.map(
    (role) => `  ${role}:\n    executors: [${entry('one')}, ${entry('two')}]\n`,
  ).join('');
  return `executors:\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${extra}`;
}

function fakes(): PlayFakes & { readonly clock: FakeClock } {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({
        launcher,
        baseEnv: {},
        env: { ...env, FAKE_AGENT_SCRIPT: 'echo', FAKE_AGENT_UPDATES_ON_CONFIG: '1' },
        adapterVersion: '1.0.0',
        command,
      }),
  };
}

interface Rig {
  readonly harness: PlayHarness;
  readonly clock: FakeClock;
  readonly scenarioId: string;
  call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }>;
  /** Every event of the log of a type. */
  events(type: string): Promise<any[]>;
  /** The session, once its turn is over (`idle`) and it has `turns` turns. */
  idle(sessionId: string, turns: number): Promise<any>;
  open(body?: unknown): Promise<any>;
}

async function withRig(extra: string, body: (rig: Rig) => Promise<void>): Promise<void> {
  const set = fakes();
  await withPlayDaemon(set, { extra: rolesConfig(extra) }, async (harness) => {
    for (const name of ['one', 'two']) {
      await harness.daemon.store.profiles.create({
        client: 'fake',
        name,
        kind: 'token_plan',
        provider: 'fake',
        dir: `${harness.dataDir}/profiles-of-the-test/${name}`,
        secretRef: null,
      });
    }
    const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
    const call: Rig['call'] = async (method, path, payload) => {
      const response = await fetch(`${harness.daemon.api.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return { status: response.status, json: await response.json() };
    };
    const scenarioId = await harness.openChat();
    const events: Rig['events'] = async (type) =>
      (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
        (event) => event.type === type,
      );
    const open: Rig['open'] = async (payload = {}) => {
      const opened = await call('POST', `/v1/scenarios/${scenarioId}/direct`, payload);
      expect(opened.status, JSON.stringify(opened.json)).toBe(200);
      return opened.json;
    };
    const idle: Rig['idle'] = (sessionId, turns) =>
      waitFor(`the session ${sessionId} to end turn ${String(turns)}`, async () => {
        const { json } = await call('GET', `/v1/direct/${sessionId}`);
        return json.state === 'idle' && json.turns === turns ? json : undefined;
      });
    await body({ harness, clock: set.clock, scenarioId, call, events, idle, open });
  });
}

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', args, { cwd })).stdout;

describe('the direct session, end to end with the fake agent', { timeout: 180_000 }, () => {
  itWithLauncher(
    'opens in a worktree, converses, runs a client command, is promoted to a demand and closes keeping the work',
    async () => {
      await withRig('', async ({ harness, call, events, idle, open, scenarioId }) => {
        const { rig } = harness;
        const opened = await open();
        expect(opened).toMatchObject({ status: 'opened', workspace: 'worktree' });
        const session = opened.session;
        expect(session).toMatchObject({
          scenarioId,
          state: 'idle',
          turns: 0,
          workspace: 'worktree',
          client: 'fake',
        });
        expect(session.branch).toBe(`direct/${session.id as string}`);
        // The Executor is one of the list of the Actor and the session leaves the Director out of it.
        expect([entry('one'), entry('two')]).toContain(session.executor);
        expect(session.commands.map((item: any) => item.name)).toContain('/fake:fake-command');

        // It converses: the message goes to the Actor and its reply comes back as the turn ends.
        const sent = await call('POST', `/v1/direct/${session.id as string}/messages`, {
          text: 'hello direct actor',
        });
        expect(sent).toMatchObject({ status: 200, json: { turn: 1 } });
        const first = await idle(session.id, 1);
        const said = first.items.filter((item: any) => item.kind === 'message');
        expect(said.map((item: any) => item.from)).toEqual(['producer', 'actor']);
        expect(said[1].text).toContain('hello direct actor');
        expect(said[1].streaming).toBe(false);

        // A client command is a turn of its own, filtered like the ones of the chat.
        const command = await call('POST', `/v1/direct/${session.id as string}/commands`, {
          text: '/fake:fake-command with arguments',
        });
        expect(command).toMatchObject({ status: 200, json: { turn: 2 } });
        const second = await idle(session.id, 2);
        expect(second.items.some((item: any) => item.kind === 'command')).toBe(true);
        expect(
          second.items.filter((item: any) => item.kind === 'message' && item.from === 'actor')[1]
            .text,
        ).toContain('/fake-command with arguments');
        const unknown = await call('POST', `/v1/direct/${session.id as string}/commands`, {
          text: '/fake:nope',
        });
        expect(unknown.status).toBe(400);

        // The result goes on as a demand: an idea of the queue of the scenario.
        const promoted = await call('POST', `/v1/direct/${session.id as string}/promote`, {
          target: 'demand',
        });
        expect(promoted.status).toBe(200);
        expect(promoted.json.target).toBe('demand');
        const idea = await harness.daemon.store.ideas.get(promoted.json.ref);
        expect(idea?.scenarioId).toBe(scenarioId);
        expect(idea?.text).toContain('fake-command with arguments');

        // A file the Actor wrote in the worktree is committed to the branch the session keeps.
        const wrote = await call('POST', `/v1/direct/${session.id as string}/messages`, {
          text: '#script:write-file {"path":"direct-note.txt","content":"from the actor\\n"}',
        });
        expect(wrote.status).toBe(200);
        await idle(session.id, 3);
        const closed = await call('POST', `/v1/direct/${session.id as string}/close`);
        expect(closed).toMatchObject({
          status: 200,
          json: { work: 'kept', branch: session.branch },
        });
        expect(await git(rig.repo, 'show', `${session.branch as string}:direct-note.txt`)).toBe(
          'from the actor\n',
        );
        await expect(
          access(join(harness.dataDir, 'worktrees', 'direct', session.id)),
        ).rejects.toThrow();
        // The repository the Producer works in is untouched.
        await expect(access(join(rig.repo, 'direct-note.txt'))).rejects.toThrow();

        // Closing again answers what the first closing found; a closed session takes no message.
        const again = await call('POST', `/v1/direct/${session.id as string}/close`);
        expect(again.json).toEqual(closed.json);
        const late = await call('POST', `/v1/direct/${session.id as string}/messages`, {
          text: 'hi',
        });
        expect(late.status).toBe(409);

        // The conversation, the tools and the closing are in the log, where trajectories read from.
        for (const type of [
          'direct.session.opened',
          'direct.session.message',
          'direct.session.command',
          'direct.session.turn_finished',
          'direct.session.promoted',
          'direct.session.closed',
        ]) {
          expect((await events(type)).length, type).toBeGreaterThan(0);
        }
        expect((await events('direct.session.closed'))[0].payload).toMatchObject({
          reason: 'closed',
          turns: 3,
          work: 'kept',
        });
        const listed = await call('GET', `/v1/scenarios/${scenarioId}/direct`);
        expect(listed.json.sessions.map((item: any) => [item.id, item.state])).toEqual([
          [session.id, 'closed'],
        ]);
      });
    },
  );

  itWithLauncher(
    'refuses the write of a readonly session and answers in the tab with what layer 2 decided',
    async () => {
      await withRig('', async ({ harness, call, events, idle, open }) => {
        const { rig } = harness;
        const opened = await open({ workspace: 'readonly' });
        const session = opened.session;
        expect(session).toMatchObject({ workspace: 'readonly', branch: null });
        await call('POST', `/v1/direct/${session.id as string}/messages`, {
          text: '#script:edit-file {"path":"barred.txt","content":"no\\n"}',
        });
        const done = await idle(session.id, 1);
        const decisions = done.items.filter((item: any) => item.kind === 'decision');
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions[0]).toMatchObject({ answered: 'reject' });
        expect(
          done.items.some((item: any) => item.kind === 'tool' && item.status === 'failed'),
        ).toBe(true);
        await expect(access(join(rig.repo, 'barred.txt'))).rejects.toThrow();
        const permissions = await events('direct.session.permission');
        expect(permissions[0].payload).toMatchObject({ sessionId: session.id, answered: 'reject' });
        // Nothing to take at the end: there was no worktree.
        const closed = await call('POST', `/v1/direct/${session.id as string}/close`);
        expect(closed.json).toEqual({ work: 'not_applicable', branch: null });
      });
    },
  );

  itWithLauncher('asks the Producer before it writes in the folder of the scenario', async () => {
    await withRig('', async ({ call, events, open, scenarioId }) => {
      const asked = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
        workspace: 'scenario',
      });
      expect(asked).toMatchObject({
        status: 200,
        json: { status: 'confirm', workspace: 'scenario' },
      });
      expect(asked.json.session).toBeUndefined();
      // Nothing happened: no session, no event of an opening.
      expect((await call('GET', `/v1/scenarios/${scenarioId}/direct`)).json.sessions).toEqual([]);
      expect(await events('direct.session.opened')).toEqual([]);
      const confirmed = await open({ workspace: 'scenario', confirm: true });
      expect(confirmed).toMatchObject({ status: 'opened', session: { workspace: 'scenario' } });
      expect(confirmed.session.branch).toBeNull();
      expect((await events('direct.session.opened'))[0].payload).toMatchObject({
        workspace: 'scenario',
      });
    });
  });

  itWithLauncher(
    'opens with the Executor chosen from the list and refuses one that is not in it',
    async () => {
      await withRig('', async ({ call, events, open, scenarioId }) => {
        const chosen = await open({ executor: entry('two') });
        expect(chosen.session).toMatchObject({ executor: entry('two'), profile: 'fake/two' });
        const other = await open({ executor: entry('one') });
        expect(other.session.profile).toBe('fake/one');
        const unknown = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
          executor: 'no-such-model@fake/zero',
        });
        expect(unknown.status).toBe(400);
        expect(unknown.json.error.code).toBe('invalid_input');
        expect((await events('direct.session.refused'))[0].payload).toMatchObject({
          code: 'not_available',
        });
      });
    },
  );

  itWithLauncher(
    'refuses to open while the profile has no quota, and opens again after the reset',
    async () => {
      await withRig('', async ({ harness, clock, call, events, scenarioId }) => {
        const resetsAt = clock.now() + 3_600_000;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        const waiting = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {});
        expect(waiting.status).toBe(429);
        expect(waiting.json.error.code).toBe('quota_exhausted');
        const named = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
          executor: entry('one'),
        });
        expect(named.status).toBe(429);
        const refused = await events('direct.session.refused');
        expect(refused.map((event) => event.payload.code)).toEqual(['waiting', 'waiting']);
        expect(refused[1].payload.profile).toBe('fake/one');
        // The refusal opened nothing and held nothing: no session, no worktree.
        expect((await call('GET', `/v1/scenarios/${scenarioId}/direct`)).json.sessions).toEqual([]);
      });
    },
  );

  itWithLauncher('stops a turn on request and refuses a message while one runs', async () => {
    await withRig('', async ({ call, idle, open }) => {
      const { session } = await open({ workspace: 'readonly' });
      const sent = await call('POST', `/v1/direct/${session.id as string}/messages`, {
        text: '#script:hang',
      });
      expect(sent.status).toBe(200);
      const busy = await call('POST', `/v1/direct/${session.id as string}/messages`, {
        text: 'again',
      });
      expect(busy.status).toBe(409);
      const cancelled = await call('POST', `/v1/direct/${session.id as string}/cancel`);
      expect(cancelled).toMatchObject({ status: 200, json: { cancelled: true } });
      const done = await idle(session.id, 1);
      expect(done.state).toBe('idle');
      const nothing = await call('POST', `/v1/direct/${session.id as string}/cancel`);
      expect(nothing.json).toEqual({ cancelled: false });
    });
  });

  itWithLauncher(
    'answers 404 for a session that is not known and 400 for a line that is no command',
    async () => {
      await withRig('', async ({ call, open }) => {
        expect((await call('GET', '/v1/direct/direct-nope')).status).toBe(404);
        expect((await call('GET', '/v1/scenarios/no-such/direct')).status).toBe(404);
        const { session } = await open({ workspace: 'readonly' });
        const bad = await call('POST', `/v1/direct/${session.id as string}/commands`, {
          text: 'plain',
        });
        expect(bad.status).toBe(400);
      });
    },
  );

  itWithLauncher('promotes to a piece only where the scenario can open a play', async () => {
    await withRig('', async ({ harness, call, idle }) => {
      const generic = await harness.openGenericChat('no repository');
      const opened = await call('POST', `/v1/scenarios/${generic}/direct`, {
        workspace: 'readonly',
      });
      expect(opened.status).toBe(200);
      const id = opened.json.session.id as string;
      await call('POST', `/v1/direct/${id}/messages`, { text: 'write a piece' });
      await idle(id, 1);
      const promoted = await call('POST', `/v1/direct/${id}/promote`, { target: 'piece' });
      expect(promoted.status).toBe(409);
    });
  });

  itWithLauncher('runs as a / command of the chat and is listed there', async () => {
    await withRig('', async ({ call, scenarioId }) => {
      const listed = await call('GET', `/v1/commands?scenario=${scenarioId}`);
      expect(listed.json.commands.map((item: any) => item.name)).toContain('/direct');
      const ran = await call('POST', `/v1/scenarios/${scenarioId}/commands`, {
        text: `/direct ${entry('two')}`,
      });
      expect(ran.status).toBe(200);
      expect(ran.json.data.session).toMatch(/^direct-/);
      const sessions = await call('GET', `/v1/scenarios/${scenarioId}/direct`);
      expect(sessions.json.sessions[0]).toMatchObject({ executor: entry('two') });
    });
  });
});

describe('the limits of the direct sessions', { timeout: 180_000 }, () => {
  itWithLauncher(
    'stops at direct_session.max_open and closes a session that stays idle',
    async () => {
      await withRig('direct_session:\n  max_open: 1\n  idle_timeout: 600ms\n', async (rig) => {
        const { call, events, open, scenarioId } = rig;
        const { session } = await open({ workspace: 'readonly' });
        const second = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
          workspace: 'readonly',
        });
        expect(second.status).toBe(409);
        expect((await events('direct.session.refused'))[0].payload).toMatchObject({
          code: 'too_many',
        });
        const closed = await waitFor('the idle session to close', async () => {
          const [event] = await events('direct.session.closed');
          return event;
        });
        expect(closed.payload).toMatchObject({ sessionId: session.id, reason: 'idle' });
        // The place is free again.
        const third = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
          workspace: 'readonly',
        });
        expect(third.status).toBe(200);
      });
    },
  );

  itWithLauncher('keeps the commands of the client behind chat.client_commands', async () => {
    await withRig('chat:\n  client_commands: off\n', async ({ call, open }) => {
      const { session } = await open({ workspace: 'readonly' });
      expect(session.commands).toEqual([]);
      const refused = await call('POST', `/v1/direct/${session.id as string}/commands`, {
        text: '/fake:fake-command',
      });
      expect(refused.status).toBe(403);
    });
    await withRig(
      'chat:\n  client_commands: allowlist\n  client_commands_allow: [other:thing]\n',
      async ({ call, open }) => {
        const { session } = await open({ workspace: 'readonly' });
        const refused = await call('POST', `/v1/direct/${session.id as string}/commands`, {
          text: '/fake:fake-command',
        });
        expect(refused.status).toBe(403);
      },
    );
    await withRig('chat:\n  slash_access: read_only\n', async ({ call, open }) => {
      const { session } = await open({ workspace: 'readonly' });
      const refused = await call('POST', `/v1/direct/${session.id as string}/commands`, {
        text: '/fake:fake-command',
      });
      expect(refused.status).toBe(403);
    });
  });

  itWithLauncher('discards the branch with direct_session.on_close: discard', async () => {
    await withRig(
      'direct_session:\n  on_close: discard\n',
      async ({ harness, call, idle, open }) => {
        const { session } = await open();
        await call('POST', `/v1/direct/${session.id as string}/messages`, {
          text: '#script:write-file {"path":"gone.txt","content":"x\\n"}',
        });
        await idle(session.id, 1);
        const closed = await call('POST', `/v1/direct/${session.id as string}/close`);
        expect(closed.json).toEqual({ work: 'discarded', branch: null });
        const branches = await git(
          harness.rig.repo,
          'branch',
          '--list',
          `direct/${session.id as string}`,
        );
        expect(branches.trim()).toBe('');
      },
    );
  });
});
