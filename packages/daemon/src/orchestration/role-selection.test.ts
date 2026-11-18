// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { QuotaStatus } from '../quota/state.js';
import { describeWait, RoleSelection } from './role-selection.js';

const entry = (profile: string): string => `fake-model@fake/${profile}`;

function status(profile: string, exhausted: boolean): QuotaStatus {
  return {
    profile,
    state: exhausted ? 'exhausted' : 'ok',
    cause: exhausted ? 'quota' : null,
    untilReset: null,
    windows: [],
    observedAt: null,
    nearLimitWindow: null,
    reason: exhausted ? 'exhausted' : 'ok',
  };
}

function rig() {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const out = new Set<string>();
  const config = parseConfig(`
orchestration:
  executor: { client: fake, profile: one, model: fake-model }
executors:
  ${entry('one')}: { client: fake, profile: one, model: fake-model }
  ${entry('two')}: { client: fake, profile: two, model: fake-model }
roles:
  actor: { executors: [${entry('one')}, ${entry('two')}] }
selection:
  recheck_every: off
`);
  const selection = new RoleSelection({
    store,
    config,
    quota: {
      statusOf: (target) => {
        const id = typeof target === 'string' ? target : `${target.client}/${target.profile}`;
        return Promise.resolve(status(id, out.has(id)));
      },
    },
    pool: { slotOf: () => 'free' },
    paths: dataPaths('/data'),
    clock,
    logger: createSilentLogger(),
  });
  const setup = async (): Promise<void> => {
    for (const name of ['one', 'two']) {
      await store.profiles.create({
        client: 'fake',
        name,
        kind: 'token_plan',
        provider: 'fake',
        dir: `/p/${name}`,
        secretRef: null,
      });
    }
  };
  return { selection, store, out, setup };
}

const selectedEvents = async (store: InMemoryStore) =>
  (await store.events.readFrom(0, 1000)).filter((event) => event.type === 'executor.selected');

const pause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('RoleSelection', () => {
  it('describes what a demand waits on, grouped by reason', () => {
    expect(
      describeWait([
        { executor: 'a', profile: 'claude-code/a', reason: 'quota' },
        { executor: 'b', profile: 'claude-code/b', reason: 'quota' },
        { executor: 'c', profile: 'codex/c', reason: 'no_slot' },
      ]),
    ).toBe('waiting for quota of claude-code/a, claude-code/b; a free slot of codex/c');
  });

  it('picks the first available Executor of the list and emits executor.selected', async () => {
    const { selection, store, setup } = rig();
    await setup();
    const picked = await selection.once({ role: 'actor' });
    expect(picked.kind).toBe('selected');
    if (picked.kind !== 'selected') return;
    expect(picked.executor.id).toBe(entry('one'));
    expect(picked.profile.id).toBe('fake/one');
    expect(await selectedEvents(store)).toHaveLength(1);
  });

  it('skips an exhausted profile and says why', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one');
    const picked = await selection.once({ role: 'actor' });
    expect(picked.kind).toBe('selected');
    if (picked.kind !== 'selected') return;
    expect(picked.executor.id).toBe(entry('two'));
    expect(picked.result.skipped).toMatchObject([{ profile: 'fake/one', reason: 'quota' }]);
  });

  it('answers waiting with the reason, and registers no wait, when it is only asked once', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one').add('fake/two');
    const answer = await selection.once({ role: 'actor' });
    expect(answer).toMatchObject({
      kind: 'waiting',
      reason: 'waiting for quota of fake/one, fake/two',
    });
    expect(selection.waiting()).toEqual([]);
  });

  it('leaves out what the caller refuses, with the reason', async () => {
    const { selection, setup } = rig();
    await setup();
    const picked = await selection.once({
      role: 'actor',
      refuse: (executor) => (executor.id === entry('one') ? 'attachment_image_not_accepted' : null),
    });
    expect(picked.kind).toBe('selected');
    if (picked.kind !== 'selected') return;
    expect(picked.executor.id).toBe(entry('two'));
    expect(picked.result.skipped).toMatchObject([
      { reason: 'invalid', detail: 'attachment_image_not_accepted' },
    ]);
  });

  it('waits while nobody is available, shows the wait, and goes on at the wake', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one').add('fake/two');
    const request = { role: 'actor', attempt: { playId: 'p1', demandId: 'd1', number: 1 } };
    const pending = selection.acquire(request);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    for (let i = 0; i < 100 && selection.waiting().length === 0; i += 1) await pause(5);
    expect(selection.waiting()).toHaveLength(1);
    expect(selection.waiting()[0]).toMatchObject({ role: 'actor', playId: 'p1', demandId: 'd1' });
    // A wake with nothing changed looks again and goes back to waiting.
    selection.wake();
    await pause(20);
    expect(done).toBe(false);
    out.delete('fake/two');
    selection.wake();
    const got = await pending;
    expect(got?.kind).toBe('selected');
    if (got?.kind !== 'selected') return;
    expect(got.executor.id).toBe(entry('two'));
    expect(selection.waiting()).toEqual([]);
  });

  it('gives up with undefined when the signal aborts or the service closes', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one').add('fake/two');
    const controller = new AbortController();
    const aborted = selection.acquire({ role: 'actor' }, { signal: controller.signal });
    const closed = selection.acquire({ role: 'actor' });
    await pause(20);
    controller.abort();
    expect(await aborted).toBeUndefined();
    selection.close();
    expect(await closed).toBeUndefined();
    expect(selection.waiting()).toEqual([]);
  });

  it('starts a retry after the Executor of the previous attempt (rotate)', async () => {
    const { selection, setup } = rig();
    await setup();
    const first = await selection.once({
      role: 'actor',
      attempt: { playId: 'p1', demandId: 'd1', number: 1 },
    });
    expect(first.kind === 'selected' && first.executor.id).toBe(entry('one'));
    const second = await selection.once({
      role: 'actor',
      attempt: { playId: 'p1', demandId: 'd1', number: 2 },
    });
    expect(second.kind === 'selected' && second.executor.id).toBe(entry('two'));
  });
});
