// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- the answers of the API are read as loose JSON */
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { buildTrajectory } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { itWithLauncher } from '../launcher-fixture.js';
import { createSilentLogger } from '../logger.js';
import {
  FAKE_AGENT_CLI,
  RealHeadCodeHost,
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

async function withRig(
  extra: string,
  body: (rig: Rig) => Promise<void>,
  kind: 'token_plan' | 'api' = 'token_plan',
  set: PlayFakes & { readonly clock: FakeClock } = fakes(),
): Promise<void> {
  await withPlayDaemon(set, { extra: rolesConfig(extra) }, async (harness) => {
    for (const name of ['one', 'two']) {
      await harness.daemon.store.profiles.create({
        client: 'fake',
        name,
        kind,
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

/** The spending cap and the shutdown of the daemon (P27, N206 items 3 and 5). */
describe('the budget and the shutdown of the direct sessions (P27)', { timeout: 180_000 }, () => {
  const CAPS = 'profiles:\n  fake/one:\n    budget:\n      daily_usd: 1\n';

  /** A turn of an Executor that cost `usd`, as the usage service reads it off a client. */
  async function spend(harness: PlayHarness, profile: string, usd: number): Promise<void> {
    const sessionId = `spend-${profile}`;
    harness.daemon.usage.bindSession(sessionId, {
      profile: `fake/${profile}`,
      executorId: entry(profile),
    });
    await harness.daemon.usage.ingestNotification({
      sessionId,
      signal: {
        kind: 'usage',
        model: 'fake-model',
        inputTokens: 10,
        outputTokens: 10,
        costUsd: usd,
      },
    });
    await harness.daemon.budget.flush();
  }

  itWithLauncher(
    'refuses to open when the spending cap of every profile is spent, as the quota does',
    async () => {
      await withRig(
        `${CAPS}  fake/two:\n    budget:\n      daily_usd: 1\n`,
        async ({ harness, call, events, scenarioId }) => {
          await spend(harness, 'one', 5);
          await spend(harness, 'two', 5);
          expect(await harness.daemon.quota.statusOf('fake/one')).toMatchObject({
            state: 'exhausted',
            cause: 'budget',
          });
          const waiting = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {});
          expect(waiting.status).toBe(429);
          expect(waiting.json.error.code).toBe('quota_exhausted');
          const named = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
            executor: entry('one'),
          });
          expect(named.status).toBe(429);
          const refused = await events('direct.session.refused');
          expect(refused.map((event) => event.payload.code)).toEqual(['waiting', 'waiting']);
          // Nothing opened and nothing is held: no session, no worktree.
          expect((await call('GET', `/v1/scenarios/${scenarioId}/direct`)).json.sessions).toEqual(
            [],
          );
          await expect(
            access(join(dataPaths(harness.dataDir).worktrees, 'direct')),
          ).rejects.toThrow();
        },
        'api',
      );
    },
  );

  itWithLauncher(
    'opens on the profile whose cap is not spent and refuses the one that is',
    async () => {
      await withRig(
        CAPS,
        async ({ harness, call, events, open, scenarioId }) => {
          await spend(harness, 'one', 5);
          // A profile under its cap does not count against the one that is over.
          await spend(harness, 'two', 0.1);
          const { session } = await open({ workspace: 'readonly' });
          expect(session.profile).toBe('fake/two');
          const named = await call('POST', `/v1/scenarios/${scenarioId}/direct`, {
            executor: entry('one'),
            workspace: 'readonly',
          });
          expect(named.status).toBe(429);
          expect((await events('direct.session.refused'))[0].payload).toMatchObject({
            profile: 'fake/one',
            code: 'waiting',
          });
        },
        'api',
      );
    },
  );

  itWithLauncher(
    'closes every open session when the daemon stops, before it says it stopped',
    async () => {
      await withRig('', async ({ harness, call, idle, open }) => {
        const { rig, daemon } = harness;
        const writer = (await open()).session;
        await call('POST', `/v1/direct/${writer.id as string}/messages`, {
          text: '#script:write-file {"path":"on-shutdown.txt","content":"saved\\n"}',
        });
        await idle(writer.id, 1);
        const reader = (await open({ workspace: 'readonly' })).session;
        const appended = vi.spyOn(daemon.store.events, 'append');
        await daemon.stop();
        const types = appended.mock.calls.map(([event]) => event.type);
        const closed = appended.mock.calls
          .map(([event]) => event)
          .filter((event) => event.type === 'direct.session.closed');
        expect(closed).toHaveLength(2);
        const byId = new Map(
          closed.map((event) => [(event.payload as any).sessionId, event.payload]),
        );
        expect(byId.get(writer.id)).toMatchObject({
          reason: 'shutdown',
          work: 'kept',
          branch: writer.branch,
          turns: 1,
        });
        expect(byId.get(reader.id)).toMatchObject({
          reason: 'shutdown',
          work: 'not_applicable',
          branch: null,
        });
        expect(types.lastIndexOf('direct.session.closed')).toBeLessThan(
          types.indexOf('daemon.stopped'),
        );
        // The worktree is gone and the work is on its branch, for the Producer to find.
        await expect(
          access(join(dataPaths(harness.dataDir).worktrees, 'direct', writer.id)),
        ).rejects.toThrow();
        expect(await git(rig.repo, 'show', `${writer.branch as string}:on-shutdown.txt`)).toBe(
          'saved\n',
        );
      });
    },
  );
});

/** The sweep of the worktrees of direct sessions that no session owns (P27, N206 item 6). */
describe('the orphan worktrees of direct sessions (P27)', { timeout: 180_000 }, () => {
  const NAME = 'direct-0a1b2c3d';

  /** What a daemon that died in the middle of a session leaves: a worktree on `direct/<id>`. */
  async function orphan(
    harness: PlayHarness,
    name = NAME,
    branch = `direct/${name}`,
  ): Promise<string> {
    const path = join(dataPaths(harness.dataDir).worktrees, 'direct', name);
    await mkdir(dirname(path), { recursive: true });
    await git(harness.rig.repo, 'worktree', 'add', '-b', branch, path, 'HEAD');
    await writeFile(join(path, 'unsaved.txt'), 'the Actor was writing\n');
    return path;
  }

  const exists = (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false,
    );
  const hasBranch = async (harness: PlayHarness, branch: string): Promise<boolean> =>
    (await git(harness.rig.repo, 'branch', '--list', branch)).trim() !== '';
  const sweeper = (harness: PlayHarness): NonNullable<DaemonHandle['direct']> => {
    const { direct } = harness.daemon;
    if (direct === undefined) throw new Error('the daemon has no direct sessions');
    return direct;
  };
  const notices = async (rig: Rig, kind: string): Promise<any[]> =>
    (await rig.events('recovery.notice')).filter((event) => event.payload.kind === kind);

  itWithLauncher('keeps and records the worktree with the default modes', async () => {
    await withRig('', async (rig) => {
      const { harness } = rig;
      const path = await orphan(harness);
      const result = await sweeper(harness).sweepOrphans();
      expect(result).toEqual({ found: [NAME], removed: [], failed: [] });
      expect(await exists(join(path, 'unsaved.txt'))).toBe(true);
      expect(await hasBranch(harness, `direct/${NAME}`)).toBe(true);
      const [found] = await notices(rig, 'direct_orphan_found');
      expect(found.payload).toMatchObject({ subject: `direct/${NAME}` });
      expect(found.payload.detail).toContain(`worktrees/direct/${NAME}`);
      // The event tells where it is under the data folder, never an absolute path.
      expect(found.payload.detail).not.toContain(harness.dataDir);
    });
  });

  itWithLauncher('discards the worktree and its branch with orphans: discard', async () => {
    await withRig('direct_session:\n  orphans: discard\n', async (rig) => {
      const { harness } = rig;
      const path = await orphan(harness);
      const result = await sweeper(harness).sweepOrphans();
      expect(result).toEqual({ found: [], removed: [NAME], failed: [] });
      expect(await exists(path)).toBe(false);
      expect(await hasBranch(harness, `direct/${NAME}`)).toBe(false);
      expect((await notices(rig, 'direct_orphan_removed'))[0].payload).toMatchObject({
        subject: `direct/${NAME}`,
      });
      // Run again: nothing is left to find.
      expect(await sweeper(harness).sweepOrphans()).toEqual({ found: [], removed: [], failed: [] });
    });
  });

  itWithLauncher('follows direct_session.on_close with orphans: on_close', async () => {
    await withRig('direct_session:\n  on_close: discard\n', async ({ harness }) => {
      const path = await orphan(harness);
      expect((await sweeper(harness).sweepOrphans()).removed).toEqual([NAME]);
      expect(await exists(path)).toBe(false);
    });
  });

  itWithLauncher('does not look with orphans: off', async () => {
    await withRig('direct_session:\n  orphans: off\n', async (rig) => {
      const { harness } = rig;
      const path = await orphan(harness);
      expect(await sweeper(harness).sweepOrphans()).toEqual({ found: [], removed: [], failed: [] });
      expect(await exists(path)).toBe(true);
      expect(await rig.events('recovery.notice')).toEqual([]);
    });
  });

  itWithLauncher('removes nothing that is not a direct worktree of its own', async () => {
    await withRig('direct_session:\n  orphans: discard\n', async (rig) => {
      const { harness } = rig;
      const base = join(dataPaths(harness.dataDir).worktrees, 'direct');
      await mkdir(base, { recursive: true });
      // A link to the repository of the Producer: removing "the worktree" would remove it.
      await symlink(harness.rig.repo, join(base, 'direct-aaaaaaaa'));
      // A plain folder that git does not list.
      await mkdir(join(base, 'direct-bbbbbbbb'));
      await writeFile(join(base, 'direct-bbbbbbbb', 'mine.txt'), 'not yours\n');
      // A worktree on a branch that is not its own.
      const foreign = await orphan(harness, 'direct-cccccccc', 'feature/foreign');
      // A folder that is not named as a session, and a file.
      await mkdir(join(base, 'notes'));
      await writeFile(join(base, 'direct-dddd.txt'), 'x\n');

      const result = await sweeper(harness).sweepOrphans();
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual(['direct-aaaaaaaa', 'direct-bbbbbbbb', 'direct-cccccccc']);
      expect(await exists(join(harness.rig.repo, '.git'))).toBe(true);
      expect(await exists(join(base, 'direct-bbbbbbbb', 'mine.txt'))).toBe(true);
      expect(await exists(join(foreign, 'unsaved.txt'))).toBe(true);
      expect(await hasBranch(harness, 'feature/foreign')).toBe(true);
      expect(await exists(join(base, 'notes'))).toBe(true);
      const failed = await notices(rig, 'direct_orphan_failed');
      expect(failed.map((event) => event.payload.subject)).toEqual([
        'direct/direct-aaaaaaaa',
        'direct/direct-bbbbbbbb',
        'direct/direct-cccccccc',
      ]);
    });
  });

  itWithLauncher('leaves the worktree of a session that is open', async () => {
    await withRig('direct_session:\n  orphans: discard\n', async ({ harness, open }) => {
      const { session } = await open();
      const path = join(dataPaths(harness.dataDir).worktrees, 'direct', session.id as string);
      await orphan(harness);
      const result = await sweeper(harness).sweepOrphans();
      expect(result.removed).toEqual([NAME]);
      expect(await exists(path)).toBe(true);
      expect(await hasBranch(harness, session.branch as string)).toBe(true);
    });
  });

  itWithLauncher('runs at start-up, before the daemon takes requests', async () => {
    const set = fakes();
    await withRig(
      'direct_session:\n  orphans: discard\n',
      async ({ harness }) => {
        const path = await orphan(harness);
        const extra = rolesConfig('direct_session:\n  orphans: discard\n');
        await harness.daemon.stop();
        expect(await exists(path)).toBe(true);
        const config = parseConfig(
          `backup:\n  when: manual\nsecurity:\n  unenforced: warn\nproject:\n  conventions: detect\norchestration:\n  executor:\n    client: fake\n    profile: one\n    model: fake-model\n${extra}`,
        );
        const launcher = defaultLauncher();
        if (launcher === undefined) throw new Error('this platform has no process launcher');
        const again = await startDaemon({
          dataDir: harness.dataDir,
          config,
          overrides: {
            clock: set.clock,
            vault: set.vault,
            launcher,
            codeHost: new RealHeadCodeHost(set.codeHost),
          },
          clients: (parts) => [
            ...productionClients(config)(parts),
            ...[
              set.client(parts.launcher, { cmd: process.execPath, args: [FAKE_AGENT_CLI] }, {}),
            ].flat(),
          ],
          logger: createSilentLogger(),
          version: '0.0.0-test',
        });
        try {
          expect(await exists(path)).toBe(false);
          expect(await hasBranch(harness, `direct/${NAME}`)).toBe(false);
          const notice = (await again.store.events.readFrom(0, 100_000)).filter(
            (event) =>
              event.type === 'recovery.notice' &&
              (event.payload as any).kind === 'direct_orphan_removed',
          );
          expect(notice).toHaveLength(1);
        } finally {
          await again.stop();
        }
      },
      'token_plan',
      set,
    );
  });
});

describe('the trajectory of a direct session (P27, N206)', { timeout: 180_000 }, () => {
  itWithLauncher(
    'reads the events of a closed session from the log, by pages, and says 404 for a stranger',
    async () => {
      await withRig('', async ({ call, idle, open }) => {
        const { session } = await open();
        const id = session.id as string;
        await call('POST', `/v1/direct/${id}/messages`, { text: 'hello trajectory' });
        await idle(id, 1);
        expect((await call('POST', `/v1/direct/${id}/close`)).status).toBe(200);

        const all = await call('GET', `/v1/direct/${id}/trajectory?limit=100`);
        expect(all.status).toBe(200);
        const types = all.json.items.map((item: any) => item.type);
        expect(types[0]).toBe('direct.session.opened');
        expect(types).toContain('direct.session.message');
        expect(types).toContain('direct.session.turn_finished');
        expect(types.at(-1)).toBe('direct.session.closed');
        expect(all.json.nextCursor).toBeNull();
        expect(all.json.items.every((item: any) => item.payload.sessionId === id)).toBe(true);

        // What the tab and the export fold from it: one closed attempt with the turn of the chat.
        const folded = buildTrajectory(id, all.json.items);
        expect(folded.attempts).toHaveLength(1);
        expect(folded.attempts[0]).toMatchObject({ demandId: undefined, state: 'closed' });
        expect(folded.attempts[0]?.turns[0]?.entries.map((entry) => entry.kind)).toContain(
          'prompt',
        );

        // Two at a time: the cursor leads to the rest, and the pages add up to the whole.
        const first = await call('GET', `/v1/direct/${id}/trajectory?limit=2`);
        expect(first.json.items).toHaveLength(2);
        expect(first.json.nextCursor).not.toBeNull();
        const rest = await call(
          'GET',
          `/v1/direct/${id}/trajectory?limit=100&after=${encodeURIComponent(first.json.nextCursor)}`,
        );
        expect([...first.json.items, ...rest.json.items].map((item: any) => item.id)).toEqual(
          all.json.items.map((item: any) => item.id),
        );

        const stranger = await call('GET', '/v1/direct/direct-ffffffff/trajectory');
        expect(stranger.status).toBe(404);
      });
    },
  );
});
