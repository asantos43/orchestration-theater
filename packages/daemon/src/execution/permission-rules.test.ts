// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, PermissionRule, RolePolicy } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TEST_POLICY } from '../test-helpers.js';
import { eventsOf, makeRig, specOf, type Rig, type RigParts } from './attempt-fixture.js';

/**
 * Acceptance of P2 (architecture 5.8, layer 2): the runner answers the requests of the client by
 * the rules of the policy, and the log tells every request and every answer. The Executor is the
 * fake one (`#script:edit-file`, which asks before it writes); the worktree is real.
 */

function fakes(transport: FakeSessionTransport = new FakeSessionTransport()) {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport,
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];

async function rig(): Promise<TestRig> {
  const made = await makeRig(fakes());
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});
afterAll(disposeTestGitIsolation);

const RULES: readonly PermissionRule[] = [
  { id: 'docs-edit', action: 'allow', kind: 'edit', path: 'docs/**' },
  { id: 'no-secrets', action: 'reject', kind: 'edit', path: 'secrets/**' },
  { id: 'any-edit', action: 'allow', kind: 'edit' },
];

function withRules(
  rules: readonly PermissionRule[],
  onAsk: RolePolicy['onAsk'] = 'rules',
): RolePolicy {
  return { ...TEST_POLICY, onAsk, rules };
}

/** The prompt that makes the fake Executor ask to edit `path`. */
const editing = (path: string): string =>
  `#script:edit-file {"path":${JSON.stringify(path)}}\nedit`;

const permissionEvents = (events: readonly EventEnvelope[]): readonly EventEnvelope[] =>
  events.filter((event) => event.type.startsWith('permission.'));

describe('layer 2 answers by the rules, with the fake agent', () => {
  it('releases a request that a rule allows, and tells both events with the deciding rule', async () => {
    const r = await rig();
    const outcome = await r.runner.run(
      specOf(r, editing('docs/guide.md'), { policy: withRules(RULES) }),
    );
    expect(outcome).toMatchObject({ state: 'completed', stopReason: 'end_turn' });

    // The answer that went to the client: the option that allows, once.
    expect(r.transport.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
    expect(r.transport.edits).toEqual(['docs/guide.md']);

    const events = permissionEvents(await eventsOf(r));
    expect(events.map((event) => event.type)).toEqual(['permission.asked', 'permission.answered']);
    expect(events[0]?.payload).toMatchObject({
      sessionId: outcome.sessionId,
      tool: 'Write',
      kind: 'edit',
      paths: ['docs/guide.md'],
      pathCount: 1,
      playId: 'play-1',
      demandId: 'demand-1',
      attemptId: outcome.attemptId,
    });
    expect(events[1]?.payload).toMatchObject({
      sessionId: outcome.sessionId,
      answer: 'allow',
      rule: 'docs-edit',
      reason: 'rule',
      attemptId: outcome.attemptId,
    });
    expect(events[1]?.payload).not.toHaveProperty('overruledRule');
    expect(events.every((event) => event.attemptId === outcome.attemptId)).toBe(true);
  });

  it('rejects a request no rule matches, with the rule "none"', async () => {
    const r = await rig();
    const policy = withRules([{ id: 'docs-edit', action: 'allow', kind: 'edit', path: 'docs/**' }]);
    const outcome = await r.runner.run(specOf(r, editing('src/main.ts'), { policy }));
    expect(outcome).toMatchObject({ state: 'completed' });
    expect(r.transport.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(r.transport.edits).toEqual([]);

    const events = permissionEvents(await eventsOf(r));
    expect(events.map((event) => event.type)).toEqual(['permission.asked', 'permission.answered']);
    expect(events[1]?.payload).toMatchObject({ answer: 'reject', rule: 'none', reason: 'no_rule' });
  });

  it('rejects a request a rule rejects, and names that rule', async () => {
    const r = await rig();
    await r.runner.run(specOf(r, editing('secrets/key.txt'), { policy: withRules(RULES) }));
    expect(r.transport.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    const events = permissionEvents(await eventsOf(r));
    expect(events[1]?.payload).toMatchObject({
      answer: 'reject',
      rule: 'no-secrets',
      reason: 'rule',
    });
  });

  it('rejects a write outside the worktree even when a rule allows it (N99)', async () => {
    const r = await rig();
    // `any-edit` allows every edit, and the request goes one level above the worktree.
    const outcome = await r.runner.run(
      specOf(r, editing('../outside.txt'), { policy: withRules(RULES) }),
    );
    expect(outcome).toMatchObject({ state: 'completed' });
    expect(r.transport.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(r.transport.edits).toEqual([]);

    const events = permissionEvents(await eventsOf(r));
    expect(events.map((event) => event.type)).toEqual(['permission.asked', 'permission.answered']);
    expect(events[1]?.payload).toMatchObject({
      answer: 'reject',
      rule: 'none',
      reason: 'write_outside_worktree',
      overruledRule: 'any-edit',
      paths: ['../outside.txt'],
    });
  });

  it('rejects an absolute path outside the worktree and one that only looks like it is inside', async () => {
    const r = await rig();
    const policy = withRules(RULES);
    for (const path of ['/etc/passwd', 'docs/../../escape.txt']) {
      await r.runner.run(
        specOf(r, editing(path), { policy, demandId: `d-${path.length}`, attempt: 1 }),
      );
    }
    expect(r.transport.permissionAnswers).toEqual([
      { outcome: 'selected', optionId: 'reject' },
      { outcome: 'selected', optionId: 'reject' },
    ]);
    const answered = (await eventsOf(r, 'permission.answered')).map((event) => event.payload);
    expect(answered.map((payload) => payload.reason)).toEqual([
      'write_outside_worktree',
      'write_outside_worktree',
    ]);
  });

  it('with on_ask: reject (the default) rejects everything and still tells the events', async () => {
    const r = await rig();
    // The rules are there but unused: the policy says `reject`.
    const policy = withRules(RULES, 'reject');
    await r.runner.run(specOf(r, editing('docs/guide.md'), { policy }));
    expect(r.transport.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    const events = permissionEvents(await eventsOf(r));
    expect(events.map((event) => event.type)).toEqual(['permission.asked', 'permission.answered']);
    expect(events[1]?.payload).toMatchObject({
      answer: 'reject',
      rule: 'none',
      reason: 'on_ask_reject',
    });
  });

  it('with no rules at all (on_ask: rules, empty list) rejects with no_rule', async () => {
    const r = await rig();
    await r.runner.run(specOf(r, editing('docs/guide.md'), { policy: withRules([]) }));
    const events = await eventsOf(r, 'permission.answered');
    expect(events[0]?.payload).toMatchObject({ answer: 'reject', rule: 'none', reason: 'no_rule' });
  });

  it('writes the events inside the turn: after the tool call opened, before the prompt finished', async () => {
    const r = await rig();
    await r.runner.run(specOf(r, editing('docs/guide.md'), { policy: withRules(RULES) }));
    const types = (await eventsOf(r)).map((event) => event.type);
    const asked = types.indexOf('permission.asked');
    expect(types.indexOf('session.opened')).toBeLessThan(asked);
    expect(types[asked + 1]).toBe('permission.answered');
    expect(asked).toBeLessThan(types.indexOf('session.prompt_finished'));
  });
});
