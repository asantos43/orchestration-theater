// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import {
  DEFAULT_SELECTION_SETTINGS,
  NotFound,
  parseExecutorId,
  type Profile,
  type ResolvedExecutor,
  type SelectionPorts,
  type Store,
} from '@otheater/core';
import type { ScenarioHandoffNotice } from '@otheater/protocol';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { editsPrompt, TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import { createHandoffPort, type HandoffPort, type HandoffRequest } from './handoff.js';
import { DEFAULT_PACKAGE_SETTINGS, type ExecutionSettings } from './settings.js';

/**
 * P18: the passing of the baton, on the fake agent. The first Executor is interrupted (quota, a
 * drop of the client that cannot be reloaded, a stuck turn); the port picks the next Executor; the
 * new session opens with the continuation package as its prompt. The fake agent echoes its prompt,
 * so the package a session got is read back from the events of that session.
 */

const TEST_TIMEOUT_MS = 30_000;
const PLAY = 'play-1';
const ATTEMPT = 'play-1/demand-1/1';
const ID_ONE = 'fake-model@fake/one';
const ID_TWO = 'fake-model@fake/two';
const PREFIX = 'ROLE PREFIX: you are the actor.';
const TWO: Profile = { client: 'fake', profile: 'two', id: 'fake/two', dir: '/profiles/fake/two' };

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type Parts = ReturnType<typeof fakes>;
type TestRig = Rig<Parts>;

const rigs: TestRig[] = [];

async function rig(
  handoff?: (parts: Parts) => HandoffPort,
  overrides: Partial<ExecutionSettings> = {},
): Promise<TestRig> {
  const parts = fakes();
  const made = await makeRig(parts, overrides, undefined, undefined, handoff?.(parts));
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});

afterAll(disposeTestGitIsolation);

/** The scenario, the play and the demand the package reads, and the orders in force at the start. */
async function seed(store: Store, orders: readonly string[] = []): Promise<string[]> {
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'play.default',
    name: 'handoff',
    folder: '/work/handoff',
    baseBranch: 'main',
  });
  await store.plays.create({
    id: PLAY,
    scenarioId: 's1',
    need: 'add the endpoint',
    flowId: 'play.default',
    flowVersion: 1,
    state: 'EXECUTING',
    counters: {},
  });
  await store.demands.create({
    playId: PLAY,
    id: 'demand-1',
    title: 'Add the health endpoint',
    description: 'GET /health answers 200.',
    dependsOn: [],
    contract: { inputs: [], outputs: [{ name: 'health', kind: 'file' }] },
    expectedFiles: ['a.txt'],
    complexity: 'low',
    timeoutMin: 10,
    acceptanceCriteria: ['the endpoint answers 200'],
    verify: [],
    verifyWaiver: 'none',
    state: 'running',
  });
  const ids: string[] = [];
  for (const text of orders) {
    const created = await store.directives.create({
      scope: 'local',
      scenarioId: 's1',
      kind: 'instruction',
      text,
      origin: 'chat',
    });
    ids.push(created.id);
  }
  return ids;
}

/** An install and a commit that the first Executor already did, as P22 records them. */
async function seedEffects(store: Store): Promise<string[]> {
  const keys = [`${PLAY}:install_deps:${ATTEMPT}:1`, `${PLAY}:git_commit:${ATTEMPT}:1`];
  const types = ['install_deps', 'git_commit'];
  for (const [index, key] of keys.entries()) {
    await store.sideEffects.intend({
      idempotencyKey: key,
      type: types[index] ?? 'install_deps',
      target: index === 0 ? 'pnpm install' : 'branch work',
      attemptId: ATTEMPT,
    });
    await store.sideEffects.resolve(key, { state: 'done', result: { ok: true, n: index } });
  }
  return keys;
}

interface Scripted {
  readonly port: HandoffPort;
  readonly requests: HandoffRequest[];
  readonly notices: ScenarioHandoffNotice[];
}

/** A port that always hands the work to `fake/two` and records what it was asked. */
function scripted(
  extra: { onChoose?: () => Promise<void> | void; secretPaths?: readonly string[] } = {},
): Scripted {
  const requests: HandoffRequest[] = [];
  const notices: ScenarioHandoffNotice[] = [];
  const port: HandoffPort = {
    prefixOf: () => PREFIX,
    async choose(request) {
      requests.push(request);
      await extra.onChoose?.();
      if (request.used.includes(ID_TWO)) return { kind: 'none', reason: 'no_other_executor' };
      return {
        kind: 'selected',
        target: {
          executorId: ID_TWO,
          profile: TWO,
          executor: { model: 'fake-model' },
          policy: TEST_POLICY,
        },
      };
    },
    announce: (notice) => {
      notices.push(notice);
    },
    secretPaths: extra.secretPaths ?? [],
  };
  return { port, requests, notices };
}

/** What the session echoed back: the prompt it was opened with. */
async function promptOf(r: TestRig, sessionId: string): Promise<string> {
  const updates = await eventsOf(r, 'session.update');
  return updates
    .map(
      (event) =>
        event.payload as {
          sessionId: string;
          update: { kind: string; content?: { text?: string } };
        },
    )
    .filter(
      (payload) => payload.sessionId === sessionId && payload.update.kind === 'agent_message_chunk',
    )
    .map((payload) => payload.update.content?.text ?? '')
    .join('');
}

function orderOf(text: string, headings: readonly string[]): number[] {
  return headings.map((heading) => text.indexOf(heading));
}

describe('the handoff, the five parts of the package', () => {
  it(
    'an Actor stopped by exhausted quota gets the baton on another profile, with the whole package and nothing redone',
    async () => {
      let sent: Scripted | undefined;
      const r = await rig(() => (sent = scripted()).port);
      await seed(r.store, ['Commit messages in Portuguese']);
      const keys = await seedEffects(r.store);
      const first = editsPrompt({ 'a.txt': 'a\n' }, '#script:quota-signal');

      const outcome = await r.runner.run(specOf(r, first, { role: 'actor' }));

      expect(outcome).toMatchObject({
        state: 'completed',
        attemptId: ATTEMPT,
        resumes: 0,
        handoffs: [
          {
            cause: 'quota_exhausted',
            from: ID_ONE,
            to: ID_TWO,
            previousSessionId: 'fake-session-1',
            countedAsAttempt: false,
          },
        ],
      });
      // A new session on the other profile; no conversation was reloaded.
      expect(r.transport.opened).toHaveLength(2);
      expect(r.transport.loaded).toHaveLength(0);
      expect(await r.store.attempts.get(ATTEMPT)).toMatchObject({
        client: 'fake',
        profile: 'two',
        state: 'completed',
        attempt: 1,
        resumes: 0,
        freeResumes: 0,
      });
      expect(sent?.requests).toEqual([
        {
          attemptId: ATTEMPT,
          playId: PLAY,
          demandId: 'demand-1',
          role: 'actor',
          cause: 'quota_exhausted',
          from: ID_ONE,
          used: [ID_ONE],
        },
      ]);

      const text = await promptOf(r, 'fake-session-2');
      // The stable prefix of the role first, then the parts in their order.
      expect(text.startsWith(PREFIX)).toBe(true);
      const headings = [
        '## Continuation of attempt',
        '## Task',
        '## Demand',
        '## Orders in force now',
        '## Worktree',
        '## What happened so far',
        '## Effects already executed',
        '## Why you are resuming',
      ];
      const places = orderOf(text, headings);
      expect(places.every((place) => place >= 0)).toBe(true);
      expect([...places].sort((a, b) => a - b)).toEqual(places);
      // 1. demand, contract, acceptance criteria and the orders in force.
      expect(text).toContain('Add the health endpoint');
      expect(text).toContain('the endpoint answers 200');
      expect(text).toContain('Commit messages in Portuguese');
      // 2. the worktree: the checkpoint commit and the difference against the base.
      expect(text).toContain(`Last checkpoint commit: ${outcome.checkpointSha ?? 'none'}`);
      expect(outcome.checkpointSha).toBeDefined();
      expect(text).toContain('a.txt (+1 -0)');
      // 3. the trajectory, from the events.
      expect(text).toMatch(/Files edited \(1\):\n- a\.txt|Edits with no path/);
      // 4. the effects already executed.
      for (const key of keys) expect(text).toContain(key);
      // 5. the reason and the instruction.
      expect(text).toContain('Cause: quota_exhausted');
      expect(text).toContain('Continue from this state; do not redo what is concluded.');
      expect(text).toContain(`from ${ID_ONE} to ${ID_TWO}`);

      // Nothing was redone: one checkpoint commit, the same two recorded effects, still `done`.
      const commits = await testGit(outcome.worktree, 'log', '--format=%s', 'main..HEAD');
      expect(commits.trim().split('\n')).toHaveLength(1);
      expect(commits).toMatch(/^wip\(checkpoint\)/);
      const effects = await r.store.sideEffects.list({ attemptId: ATTEMPT });
      expect(effects.map((effect) => effect.idempotencyKey).sort()).toEqual([...keys].sort());
      expect(effects.every((effect) => effect.state === 'done')).toBe(true);
      // The key of `attempt + step` is the same after the handoff, so a repeated call finds its record.
      expect((await r.store.sideEffects.get(keys[0] ?? ''))?.result).toEqual({ ok: true, n: 0 });
      const attempts = await r.store.attempts.list();
      expect(attempts.map((attempt) => attempt.attemptId)).toEqual([ATTEMPT]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the events carry the form and both Executors, and the chat gets a system message',
    async () => {
      let sent: Scripted | undefined;
      const r = await rig(() => (sent = scripted()).port);
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome.state).toBe('completed');

      const [interrupted] = await eventsOf(r, 'session.interrupted');
      expect(interrupted?.payload).toMatchObject({
        sessionId: 'fake-session-1',
        cause: 'quota_exhausted',
        form: 'handoff',
        from: { client: 'fake', profile: 'one', model: 'fake-model' },
        to: { client: 'fake', profile: 'two', model: 'fake-model' },
      });
      const [resumed] = await eventsOf(r, 'session.resumed');
      expect(resumed?.payload).toMatchObject({
        sessionId: 'fake-session-2',
        previousSessionId: 'fake-session-1',
        form: 'handoff',
        cause: 'quota_exhausted',
        from: { profile: 'one' },
        to: { profile: 'two' },
      });
      const rows = await r.store.interruptions.list();
      expect(rows[0]).toMatchObject({
        resumeForm: 'handoff',
        fromExecutor: ID_ONE,
        toExecutor: ID_TWO,
        countedAsAttempt: false,
      });

      const messages = await eventsOf(r, 'scenario.system_message');
      expect(messages).toHaveLength(1);
      const notice = {
        scenarioId: 's1',
        kind: 'handoff',
        playId: PLAY,
        attemptId: ATTEMPT,
        role: 'actor',
        cause: 'quota_exhausted',
        fromExecutor: ID_ONE,
        toExecutor: ID_TWO,
      };
      expect(messages[0]?.payload).toEqual(notice);
      expect(sent?.notices).toEqual([notice]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a native resume that fails becomes a handoff to the next Executor',
    async () => {
      let sent: Scripted | undefined;
      let transport: Parts['transport'] | undefined;
      const r = await rig((parts) => {
        transport = parts.transport;
        sent = scripted({
          // The conversation was gone when it was reloaded; the new session opens fine.
          onChoose: () => {
            parts.transport.failWith = undefined;
          },
        });
        return sent.port;
      });
      await seed(r.store);
      const running = r.runner.run(
        specOf(r, editsPrompt({ 'a.txt': 'a\n' }, '#script:hang'), { role: 'actor' }),
      );
      await until(
        async () => (await eventsOf(r, 'session.update')).length > 0,
        'the first session to work',
      );
      r.launcher.launched[0]?.exit(137);
      if (transport !== undefined) transport.failWith = new NotFound('no such conversation');
      const outcome = await running;

      expect(outcome).toMatchObject({ state: 'completed', attemptId: ATTEMPT });
      expect(outcome.handoffs).toHaveLength(1);
      expect(outcome.handoffs[0]).toMatchObject({
        cause: 'client_crash',
        from: ID_ONE,
        to: ID_TWO,
      });
      // The reload was tried, and only then the baton was passed.
      expect(r.transport.loaded).toHaveLength(1);
      expect(sent?.requests).toHaveLength(1);
      const rows = await r.store.interruptions.list();
      // The row of the drop said `native` when it was written; the baton settles it.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        resumeForm: 'handoff',
        fromExecutor: ID_ONE,
        toExecutor: ID_TWO,
      });
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('Continue from this state; do not redo what is concluded.');
      expect(text).toContain('a.txt');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the package carries the orders in force at the resume, not the ones at the start',
    async () => {
      const orders: string[] = [];
      const r = await rig(
        () =>
          scripted({
            // While the first Executor worked the Producer revoked one order and gave another.
            onChoose: async () => {
              for (const order of orders) await r.store.directives.revoke(order, 'changed my mind');
              await r.store.directives.create({
                scope: 'local',
                scenarioId: 's1',
                kind: 'instruction',
                text: 'Use spaces, never tabs',
                origin: 'chat',
              });
            },
          }).port,
      );
      orders.push(...(await seed(r.store, ['Use tabs, never spaces'])));

      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome.state).toBe('completed');
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('## Orders in force now');
      expect(text).toContain('Use spaces, never tabs');
      expect(text).not.toContain('Use tabs, never spaces');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a stuck Executor hands the baton over and the policy still says the interruption counts',
    async () => {
      const r = await rig(() => scripted().port, { stuckNoEventMs: 5000 });
      await seed(r.store);
      const running = r.runner.run(specOf(r, '#script:hang', { role: 'actor' }));
      await until(
        async () => (await eventsOf(r, 'session.update')).length > 0,
        'the first session to hang',
      );
      await r.clock.advance(5000);
      const outcome = await running;
      expect(outcome.state).toBe('completed');
      // The handoff itself is no new attempt of the demand: the same attempt goes on.
      expect(outcome).toMatchObject({
        attemptId: ATTEMPT,
        handoffs: [{ cause: 'stuck', countedAsAttempt: true }],
      });
      expect((await r.store.attempts.get(ATTEMPT))?.attempt).toBe(1);
      expect((await r.store.attempts.list()).map((a) => a.attemptId)).toEqual([ATTEMPT]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the handoff, the roles with a short output', () => {
  it(
    'a Reviewer redoes the work with the partial notes (resume.package.short_output: redo)',
    async () => {
      const r = await rig(() => scripted().port, {
        package: { ...DEFAULT_PACKAGE_SETTINGS, shortOutputRoles: ['reviewer'] },
      });
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'reviewer' }));
      expect(outcome.state).toBe('completed');
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('do the work again from the start of the task above');
      expect(text).not.toContain('Continue from this state; do not redo what is concluded.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'short_output: continue treats every role alike',
    async () => {
      const r = await rig(() => scripted().port, {
        package: {
          ...DEFAULT_PACKAGE_SETTINGS,
          shortOutput: 'continue',
          shortOutputRoles: ['reviewer'],
        },
      });
      await seed(r.store);
      await r.runner.run(specOf(r, '#script:quota-signal', { role: 'reviewer' }));
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('Continue from this state; do not redo what is concluded.');
      expect(text).not.toContain('do the work again');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'an Actor is not a short-output role: it continues',
    async () => {
      const r = await rig(() => scripted().port);
      await seed(r.store);
      await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('Continue from this state; do not redo what is concluded.');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the handoff, when nobody can take the work', () => {
  it(
    'without a port the attempt is parked with the decision, as before',
    async () => {
      const r = await rig();
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        decision: { action: 'handoff' },
        handoffs: [],
        handoffWait: { reason: 'no_port', on: [], until: null },
      });
      expect(r.transport.opened).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a port that finds nobody parks the attempt and says why',
    async () => {
      const r = await rig(() => ({
        prefixOf: () => PREFIX,
        choose: () => Promise.resolve({ kind: 'none', reason: 'no_other_executor' }),
      }));
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        handoffWait: { reason: 'no_other_executor' },
      });
      const [interrupted] = await eventsOf(r, 'session.interrupted');
      // No target, so the event says only the form.
      expect(interrupted?.payload).toMatchObject({ form: 'handoff' });
      expect(interrupted?.payload).not.toHaveProperty('to.profile');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a port that fails does not take the attempt down',
    async () => {
      const r = await rig(() => ({
        prefixOf: () => PREFIX,
        choose: () => Promise.reject(new Error('the catalog is down')),
      }));
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        handoffWait: { reason: 'selection_failed' },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the handoff over the selector of P15', () => {
  const ports: SelectionPorts = {
    profile: () => ({ state: 'active' }),
    health: () => true,
    quota: () => ({ state: 'ok', cause: null, untilReset: null, headroom: 0.5 }),
    admission: () => ({ slot: 'free', ram: 'ok' }),
    contextWindow: () => 200_000,
  };

  function resolved(id: string): ResolvedExecutor {
    const parsed = parseExecutorId(id);
    return {
      id,
      entry: {
        id,
        client: parsed.client,
        profile: parsed.profile,
        model: parsed.model,
        effort: parsed.effort,
        provider: 'unknown',
      },
      validity: 'valid',
      invalidReason: null,
      shortfalls: [],
      origin: 'config',
    };
  }

  const profiles: Record<string, Profile> = { one: TEST_PROFILE, two: TWO };

  function over(prefix: string, notices: ScenarioHandoffNotice[] = []): HandoffPort {
    return createHandoffPort({
      selection: ports,
      settings: DEFAULT_SELECTION_SETTINGS,
      roleOf: (role) =>
        Promise.resolve({
          role,
          executors: [resolved(ID_ONE), resolved(ID_TWO)],
          whenExhausted: 'next',
        }),
      launch: (entry) =>
        Promise.resolve({
          executorId: entry.id,
          profile: profiles[entry.profile] ?? TEST_PROFILE,
          executor: { model: entry.model },
          policy: TEST_POLICY,
        }),
      prefixOf: () => prefix,
      announce: (notice) => {
        notices.push(notice);
      },
    });
  }

  it(
    'picks the next Executor of the role and writes executor.selected',
    async () => {
      const r = await rig(() => over(PREFIX));
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome).toMatchObject({
        state: 'completed',
        handoffs: [{ from: ID_ONE, to: ID_TWO }],
      });
      const selected = await eventsOf(r, 'executor.selected');
      expect(selected).toHaveLength(1);
      expect(selected[0]?.payload).toMatchObject({ role: 'actor' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never gives the baton back to an Executor that passed it, even when its quota is fine',
    async () => {
      // The prefix is the first line of the prompt: `#script:quota-signal` makes the second
      // session fail too, with `fake/one` perfectly healthy in the selector's eyes.
      const r = await rig(() => over('#script:quota-signal'));
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'actor' }));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'quota_exhausted',
        handoffs: [{ from: ID_ONE, to: ID_TWO }],
        handoffWait: { reason: 'no_other_executor' },
      });
      expect(r.transport.opened).toHaveLength(2);
      const rows = await r.store.interruptions.list();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ fromExecutor: ID_TWO, toExecutor: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a role that is not one of the seven has no list to choose from',
    async () => {
      const r = await rig(() => over(PREFIX));
      await seed(r.store);
      const outcome = await r.runner.run(specOf(r, '#script:quota-signal', { role: 'wizard' }));
      expect(outcome).toMatchObject({ state: 'interrupted', handoffWait: { reason: 'no_role' } });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the handoff and the secrets', () => {
  it(
    'the package carries no secret, no credential path, no key in an order',
    async () => {
      const r = await rig(
        () => scripted({ secretPaths: ['.env', '*.pem', '/home/dev/.aws'] }).port,
      );
      await seed(r.store, ['Deploy with the key sk-abcdefghijklmnopqrstuvwx and nothing else']);
      const first = editsPrompt(
        { 'src/app.ts': 'x\n', '.env': 'TOKEN=abc\n', 'config/server.pem': 'pem\n' },
        '#script:quota-signal',
      );
      const outcome = await r.runner.run(specOf(r, first, { role: 'actor' }));
      expect(outcome.state).toBe('completed');
      const text = await promptOf(r, 'fake-session-2');
      expect(text).toContain('src/app.ts');
      expect(text).not.toContain('.env');
      expect(text).not.toContain('server.pem');
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
      expect(text).not.toContain('/home/dev/.aws');
      expect(text).toContain('[REDACTED]');
      // Even the first prompt, which names them, is scrubbed when it is shown as the task.
      expect(text).toContain('left out: they touch the secret list');
    },
    TEST_TIMEOUT_MS,
  );
});
