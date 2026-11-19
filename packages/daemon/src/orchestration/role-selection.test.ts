// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { QuotaStatus } from '../quota/state.js';
import { describeWait, RoleSelection, type AcquireWatch, type WaitEnd } from './role-selection.js';

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

function rig(extra = '', onNotice?: (notice: unknown) => void) {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const out = new Set<string>();
  const config = parseConfig(`
orchestration:
  executor: { client: fake, profile: one, model: fake-model }
executors:
  ${entry('one')}: { client: fake, profile: one, model: fake-model, provider: fake }
  ${entry('two')}: { client: fake, profile: two, model: fake-model, provider: other }
roles:
  actor: { executors: [${entry('one')}, ${entry('two')}] }
  reviewer: { executors: [${entry('one')}, ${entry('two')}] }
selection:
  recheck_every: off
${extra}`);
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
    ...(onNotice === undefined ? {} : { onNotice }),
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

describe('RoleSelection: the watch of a wait (P16b)', () => {
  it('tells the watcher once when the wait starts and once when it ends', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one').add('fake/two');
    const started: string[] = [];
    const ended: WaitEnd[] = [];
    const watch: AcquireWatch = {
      started: (wait) => {
        started.push(wait.message);
      },
      ended: (end) => {
        ended.push(end);
      },
    };
    const pending = selection.acquire({ role: 'actor' }, { watch });
    for (let i = 0; i < 100 && started.length === 0; i += 1) await pause(5);
    selection.wake();
    await pause(20);
    expect(started).toEqual(['waiting for quota of fake/one, fake/two']);
    expect(ended).toEqual([]);
    out.delete('fake/one');
    selection.wake();
    const got = await pending;
    expect(got?.kind).toBe('selected');
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'selected', executor: entry('one') });
  });

  it('does not call the watcher when an Executor is there at the first try', async () => {
    const { selection, setup } = rig();
    await setup();
    const calls: string[] = [];
    const got = await selection.acquire(
      { role: 'actor' },
      {
        watch: {
          started: () => {
            calls.push('started');
          },
          ended: () => {
            calls.push('ended');
          },
        },
      },
    );
    expect(got?.kind).toBe('selected');
    expect(calls).toEqual([]);
  });

  it('ends the watch with cancelled when the signal aborts, and survives a watcher that throws', async () => {
    const { selection, out, setup } = rig();
    await setup();
    out.add('fake/one').add('fake/two');
    const controller = new AbortController();
    const ended: WaitEnd[] = [];
    const pending = selection.acquire(
      { role: 'actor' },
      {
        signal: controller.signal,
        watch: {
          started: () => {
            throw new Error('the watcher broke');
          },
          ended: (end) => {
            ended.push(end);
          },
        },
      },
    );
    await pause(30);
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'cancelled', executor: null });
  });
});

describe('RoleSelection: the notice of the strict cross-review (N135, P16b)', () => {
  const strict = '  cross_check: require_other_provider\n  strict_unavailable: wait_notify\n';
  const request = {
    role: 'reviewer',
    scenarioId: 'S1',
    workedBy: { provider: 'fake' },
    attempt: { playId: 'p1', demandId: 'd1', number: 1 },
  } as const;

  it('writes the scenario.system_message and calls onNotice once per wait', async () => {
    const notices: unknown[] = [];
    const { selection, store, out, setup } = rig(strict, (notice) => notices.push(notice));
    await setup();
    out.add('fake/two');
    const pending = selection.acquire(request);
    for (let i = 0; i < 100 && notices.length === 0; i += 1) await pause(5);
    selection.wake();
    await pause(20);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      scenarioId: 'S1',
      kind: 'selection_wait',
      role: 'reviewer',
      crossCheck: 'require_other_provider',
      workedProvider: 'fake',
    });
    const messages = (await store.events.readFrom(0, 1000)).filter(
      (event) => event.type === 'scenario.system_message',
    );
    expect(messages).toHaveLength(1);
    selection.close();
    expect(await pending).toBeUndefined();
  });

  it('says nothing with strict_unavailable: wait', async () => {
    const notices: unknown[] = [];
    const quiet = strict.replace('wait_notify', 'wait');
    const { selection, store, out, setup } = rig(quiet, (notice) => notices.push(notice));
    await setup();
    out.add('fake/two');
    const pending = selection.acquire(request);
    await pause(40);
    expect(notices).toEqual([]);
    const messages = (await store.events.readFrom(0, 1000)).filter(
      (event) => event.type === 'scenario.system_message',
    );
    expect(messages).toEqual([]);
    selection.close();
    await pending;
  });
});

describe('RoleSelection: the fall to the provider of the work in the event (P15b, N150)', () => {
  const request = {
    role: 'reviewer',
    scenarioId: 'S1',
    workedBy: { provider: 'fake', model: 'fake-model', effort: null, profile: 'fake/one' },
    attempt: { playId: 'p1', demandId: 'd1', number: 1 },
  } as const;

  it('records the step, the account and that the list had another provider', async () => {
    const { selection, store, out, setup } = rig();
    await setup();
    out.add('fake/two');
    const picked = await selection.once(request);
    expect(picked.kind).toBe('selected');
    const [event] = await selectedEvents(store);
    expect(event?.schemaVersion).toBe(2);
    expect(event?.payload).toMatchObject({
      executor: entry('one'),
      crossCheck: {
        applied: true,
        fellBack: true,
        degraded: 'same',
        noneConfigured: false,
        sameAccount: true,
        blocked: false,
      },
    });
  });

  it('records no fall when the other provider is taken', async () => {
    const { selection, store, setup } = rig();
    await setup();
    const picked = await selection.once(request);
    expect(picked.kind).toBe('selected');
    const [event] = await selectedEvents(store);
    expect(event?.payload).toMatchObject({
      executor: entry('two'),
      crossCheck: { fellBack: false, degraded: null, sameAccount: false },
    });
  });
});

describe('RoleSelection: profiles.rotate_on_exhaustion (P26, N157)', () => {
  function rotationRig(extra = '') {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const out = new Set<string>();
    const notices: { type: string; payload: unknown; correlation: unknown }[] = [];
    const config = parseConfig(`
orchestration:
  executor: { client: fake, profile: one, model: fake-model }
executors:
  cross_client: any
  ${entry('one')}: { client: fake, profile: one, model: fake-model, provider: openai }
  ${entry('two')}: { client: fake, profile: two, model: fake-model, provider: openai }
  ${entry('three')}: { client: fake, profile: three, model: fake-model, provider: anthropic }
roles:
  actor: { executors: [${entry('one')}, ${entry('two')}, ${entry('three')}] }
selection:
  recheck_every: off
${extra}`);
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
      situations: {
        record: (type, payload, correlation) => {
          notices.push({ type, payload, correlation });
        },
      },
    });
    const setup = async (): Promise<void> => {
      for (const name of ['one', 'two', 'three']) {
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
    return { selection, store, out, notices, setup };
  }

  it('off by default: an exhausted OpenAI account does not pass the work to the other one', async () => {
    const { selection, out, notices, setup } = rotationRig();
    await setup();
    out.add('fake/one');
    const picked = await selection.once({ role: 'actor' });
    expect(picked.kind === 'selected' ? picked.executor.id : null).toBe(entry('three'));
    if (picked.kind !== 'selected') return;
    expect(picked.result.skipped).toMatchObject([
      { profile: 'fake/one', reason: 'quota' },
      { profile: 'fake/two', reason: 'rotation' },
    ]);
    expect(notices).toEqual([]);
  });

  it('on: the work rotates and a daemon.notice account_rotated says so', async () => {
    const { selection, out, notices, setup } = rotationRig(`
profiles:
  rotate_on_exhaustion: { openai: on }`);
    await setup();
    out.add('fake/one');
    const picked = await selection.once({
      role: 'actor',
      attempt: { playId: 'play-1', demandId: 'demand-1', number: 1 },
    });
    expect(picked.kind === 'selected' ? picked.executor.id : null).toBe(entry('two'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: 'daemon.notice',
      payload: { kind: 'account_rotated', subject: 'actor' },
      correlation: { playId: 'play-1', attemptId: 'play-1/demand-1/1' },
    });
    expect(JSON.stringify(notices[0]?.payload)).toContain('fake/one ran out, so fake/two');
  });

  it('off: an Executor the caller refuses (the failover of P20) holds the others through earlier', async () => {
    const { selection, out, setup } = rotationRig();
    await setup();
    out.add('fake/one');
    const refuse = (executor: { readonly id: string }) =>
      executor.id === entry('one') ? 'director_failed' : null;
    // The refused copy is invalid, so only `earlier` tells the selector whose account ran out.
    const without = await selection.once({ role: 'actor', refuse });
    expect(without.kind === 'selected' ? without.executor.id : null).toBe(entry('two'));
    const withEarlier = await selection.once({ role: 'actor', refuse, earlier: [entry('one')] });
    expect(withEarlier.kind === 'selected' ? withEarlier.executor.id : null).toBe(entry('three'));
  });

  it('the config key is read per provider, in lower case, over the default', () => {
    const config = parseConfig(`
profiles:
  rotate_on_exhaustion: { OpenAI: on, anthropic: off }`);
    expect(config.profiles.rotate_on_exhaustion).toEqual({ openai: 'on', anthropic: 'off' });
    expect(parseConfig('').profiles.rotate_on_exhaustion).toEqual({ openai: 'off' });
    expect(() => parseConfig('profiles:\n  rotate_on_exhaustion: { openai: maybe }')).toThrow();
  });
});
