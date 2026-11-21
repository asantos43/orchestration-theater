// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput, NotFound, type EventEnvelope, type Store } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { SetupRunView } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE,
  CODEX,
  DEFAULT_PROFILES,
  ListCatalog,
  MINIMAX,
  MINIMAX_EXECUTOR,
  MINIMAX_MODEL,
  T0,
  makeSetupRig,
  type SetupRig,
} from './rig-fixture.js';

const rigs: SetupRig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.dispose();
});

async function rigOf(
  options: Omit<Parameters<typeof makeSetupRig>[0], 'store' | 'clock'> & { store?: Store } = {},
): Promise<SetupRig> {
  const clock = new FakeClock(T0);
  const rig = await makeSetupRig({
    ...options,
    clock,
    store: options.store ?? new InMemoryStore({ clock }),
  });
  rigs.push(rig);
  return rig;
}

async function eventTypes(rig: SetupRig): Promise<string[]> {
  const events: readonly EventEnvelope[] = await rig.store.events.readFrom(0, 1000);
  return events.map((event) => event.type).filter((type) => type.startsWith('setup.'));
}

const API_EXECUTORS = { executors: [{ profileId: MINIMAX, model: MINIMAX_MODEL }] };

/** The three answers of a first run, ready for the review. */
async function toReview(rig: SetupRig, service = rig.service()): Promise<SetupRunView> {
  const run = await service.start('first_run');
  await service.submit(run.id, { step: 'detect', input: {} });
  await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
  return service.submit(run.id, { step: 'executors', input: API_EXECUTORS });
}

describe('the first run, from the start to the confirmation', () => {
  it('says a first run is needed while the configuration has no preset and no Executor', async () => {
    const rig = await rigOf();
    const overview = await rig.service().overview();
    expect(overview.firstRunNeeded).toBe(true);
    expect(overview.flows.map((flow) => [flow.flow, flow.active])).toEqual([
      ['first_run', null],
      ['add_account', null],
      ['change_preset', null],
    ]);
  });

  it('detects the clients and the accounts as states, and proposes the usable ones', async () => {
    const rig = await rigOf({ installed: ['claude-code', 'codex'] });
    const run = await rig.service().start('first_run');
    expect(run).toMatchObject({ flow: 'first_run', state: 'active', step: 'detect', done: [] });
    expect(run.prompt).toMatchObject({ step: 'detect' });
    if (run.prompt?.step !== 'detect') throw new Error('expected the detect prompt');
    expect(run.prompt.clients).toEqual([
      { client: 'claude-code', installed: true },
      { client: 'codex', installed: true },
      { client: 'opencode', installed: false },
    ]);
    expect(run.prompt.profiles.map((p) => [p.profileId, p.usable, p.hasSecret, p.login])).toEqual([
      [CLAUDE, true, false, 'logged_in'],
      [CODEX, true, false, 'logged_in'],
      [MINIMAX, true, true, null],
    ]);
  });

  it('a subscription account that is logged out is detected but not proposed', async () => {
    const rig = await rigOf();
    rig.logins.set(CODEX, 'logged_out');
    const service = rig.service();
    const run = await service.start('first_run');
    const after = await service.submit(run.id, { step: 'detect', input: {} });
    expect(after.done[0]).toMatchObject({
      step: 'detect',
      output: { accounts: [CLAUDE, MINIMAX] },
    });
  });

  it('runs every step, shows the plan, and writes the expected configuration at the confirmation', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const review = await toReview(rig, service);
    expect(review.step).toBe('review');
    expect(review.prompt?.step).toBe('review');
    // Nothing is written before the confirmation.
    expect(await rig.text()).toBe('');

    if (review.prompt?.step !== 'review') throw new Error('expected the review prompt');
    const { plan } = review.prompt;
    expect(plan.preset).toBe('quality');
    expect(plan.executors.map((executor) => executor.id).sort()).toEqual(
      [
        `claude-opus-high@${CLAUDE}`,
        `claude-sonnet-medium@${CLAUDE}`,
        `claude-haiku-low@${CLAUDE}`,
        `codex-sol-high@${CODEX}`,
        `codex-luna-low@${CODEX}`,
        MINIMAX_EXECUTOR,
      ].sort(),
    );
    // The API account has an Executor and no cap: the suggested one is proposed.
    expect(plan.budgets).toEqual([{ profileId: MINIMAX, dailyUsd: 20, monthlyUsd: 200 }]);
    expect(plan.notes.map((note) => note.code)).toContain('budget_suggested');

    const done = await service.confirm(review.id);
    expect(done).toMatchObject({ state: 'confirmed', prompt: null, step: 'review' });
    expect(done.result?.preset).toBe('quality');
    expect(done.result?.executors.sort()).toEqual(plan.executors.map((e) => e.id).sort());

    const config = await rig.config();
    expect(config.roles.preset).toBe('quality');
    expect(Object.keys(config.executors.entries).sort()).toEqual(
      plan.executors.map((e) => e.id).sort(),
    );
    expect(config.executors.entries[MINIMAX_EXECUTOR]).toMatchObject({
      client: 'opencode',
      profile: 'minimax',
      model: MINIMAX_MODEL,
      effort: 'medium',
      provider: 'minimax',
    });
    expect(config.profiles.entries[MINIMAX]?.budget).toMatchObject({
      daily_usd: 20,
      monthly_usd: 200,
    });
    // `setup.role_lists: explicit`: each role has its list, from the accounts that exist.
    // `roles.api_fallback` puts the API Executor at the end of the roles that the preset does not give it.
    expect(config.roles.author?.executors).toEqual([
      `claude-opus-high@${CLAUDE}`,
      `codex-sol-high@${CODEX}`,
      MINIMAX_EXECUTOR,
    ]);
    expect(config.roles.actor?.executors).toEqual([
      `codex-sol-high@${CODEX}`,
      `claude-sonnet-medium@${CLAUDE}`,
      MINIMAX_EXECUTOR,
    ]);
    // The Executors that do not exist (the local `gemma4` of the Director) were dropped.
    expect(config.roles.director?.executors).toEqual([
      `claude-haiku-low@${CLAUDE}`,
      `codex-luna-low@${CODEX}`,
      MINIMAX_EXECUTOR,
    ]);

    // The table of Executors has a valid row for each one.
    for (const id of done.result?.executors ?? []) {
      expect((await rig.store.executors.get(id))?.validity).toBe('valid');
    }
    expect(await eventTypes(rig)).toEqual([
      'setup.started',
      'setup.step',
      'setup.step',
      'setup.step',
      'setup.confirmed',
    ]);
    expect((await service.overview()).firstRunNeeded).toBe(false);
  });

  it('keeps the comments of the file and writes only keys that are not secrets', async () => {
    const rig = await rigOf({ configYaml: '# my notes\nlog:\n  level: warn # keep it quiet\n' });
    const service = rig.service();
    const review = await toReview(rig, service);
    await service.confirm(review.id);
    const text = await rig.text();
    expect(text).toContain('# my notes');
    expect(text).toContain('level: warn # keep it quiet');
    expect(text).not.toMatch(/vault:/);
    expect(text).not.toMatch(/secret|token|api_key/i);
    expect((await rig.config()).log.level).toBe('warn');
  });

  it('without any API account, the plan has no cap and the lists use the official clients only', async () => {
    const rig = await rigOf({ profiles: DEFAULT_PROFILES.slice(0, 2) });
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: {} });
    await service.submit(run.id, { step: 'preset', input: { preset: 'balanced' } });
    const review = await service.submit(run.id, { step: 'executors', input: {} });
    if (review.prompt?.step !== 'review') throw new Error('expected the review prompt');
    expect(review.prompt.plan.budgets).toEqual([]);
    await service.confirm(run.id);
    const config = await rig.config();
    expect(config.roles.preset).toBe('balanced');
    expect(config.profiles.entries[MINIMAX]).toBeUndefined();
    expect(config.roles.author?.executors).toEqual([
      `claude-sonnet-high@${CLAUDE}`,
      `codex-sol-medium@${CODEX}`,
    ]);
  });

  it('a cap the Producer gives wins over the suggested one, and null means none', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: {} });
    await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
    await service.submit(run.id, {
      step: 'executors',
      input: { ...API_EXECUTORS, budgets: [{ profileId: MINIMAX, dailyUsd: 5, monthlyUsd: null }] },
    });
    await service.confirm(run.id);
    const budget = (await rig.config()).profiles.entries[MINIMAX]?.budget;
    expect(budget?.daily_usd).toBe(5);
    expect(budget?.monthly_usd).toBeUndefined();
  });

  it('a catalog that is down is a note, not a failure', async () => {
    const rig = await rigOf({ catalogs: { codex: new ListCatalog([], { fail: true }) } });
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: {} });
    const after = await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
    expect(after.done[1]).toMatchObject({ step: 'preset' });
    const notes = after.done[1]?.step === 'preset' ? after.done[1].output.notes : [];
    expect(notes.map((note) => note.code)).toContain('catalog_unavailable');
    expect(after.done[1]?.step === 'preset' ? after.done[1].output.discovered : []).not.toEqual([]);
  });
});

describe('each step is validated before moving on', () => {
  it('refuses an answer for a step the run is not at, and an unknown account', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await expect(
      service.submit(run.id, { step: 'preset', input: { preset: 'quality' } }),
    ).rejects.toBeInstanceOf(Conflict);
    await expect(
      service.submit(run.id, { step: 'detect', input: { accounts: ['claude-code/nobody'] } }),
    ).rejects.toBeInstanceOf(InvalidInput);
    await expect(
      service.submit(run.id, { step: 'detect', input: { accounts: [CLAUDE, CLAUDE] } }),
    ).rejects.toBeInstanceOf(InvalidInput);
    // None of the refusals moved the run.
    expect(await service.get(run.id)).toMatchObject({ step: 'detect', done: [] });
  });

  it('refuses an input that does not fit the schema of the step', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: {} });
    await expect(
      service.submit(run.id, { step: 'preset', input: { preset: 'lavish' } as never }),
    ).rejects.toThrow();
    expect(await service.get(run.id)).toMatchObject({ step: 'preset' });
  });

  it('refuses a model the catalog does not list, and an account that is not in the run', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: { accounts: [CLAUDE, MINIMAX] } });
    await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
    await expect(
      service.submit(run.id, {
        step: 'executors',
        input: { executors: [{ profileId: MINIMAX, model: 'no/such-model' }] },
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
    await expect(
      service.submit(run.id, {
        step: 'executors',
        input: { executors: [{ profileId: CODEX, model: 'sol' }] },
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(await service.get(run.id)).toMatchObject({ step: 'executors' });
  });

  it('refuses a cap on an account that is not an API one', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await service.submit(run.id, { step: 'detect', input: {} });
    await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
    await expect(
      service.submit(run.id, {
        step: 'executors',
        input: { budgets: [{ profileId: CLAUDE, dailyUsd: 3, monthlyUsd: null }] },
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });

  it('refuses to confirm before the review, and a step after the review', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await expect(service.confirm(run.id)).rejects.toBeInstanceOf(Conflict);
    await service.cancel(run.id);
    const review = await toReview(rig, service);
    await expect(service.submit(review.id, { step: 'detect', input: {} })).rejects.toBeInstanceOf(
      Conflict,
    );
    await expect(service.get('setup-missing')).rejects.toBeInstanceOf(NotFound);
  });

  it('one active run per flow: the second start says which run to resume', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await expect(service.start('first_run')).rejects.toThrow(run.id);
    // Another flow is independent.
    expect((await service.start('change_preset')).flow).toBe('change_preset');
  });
});

describe('resuming', () => {
  it('after the TUI closes and the daemon restarts, the run is at the same step with the same answers', async () => {
    const rig = await rigOf();
    const first = rig.service();
    const run = await first.start('first_run');
    await first.submit(run.id, { step: 'detect', input: {} });
    const before = await first.submit(run.id, { step: 'preset', input: { preset: 'balanced' } });

    const second = rig.service(); // a new service over the same store and file: a restart
    const overview = await second.overview();
    const active = overview.flows.find((flow) => flow.flow === 'first_run')?.active;
    expect(active?.id).toBe(run.id);
    expect(active).toEqual(before);
    expect(active?.step).toBe('executors');
    expect(active?.done.map((entry) => entry.step)).toEqual(['detect', 'preset']);

    const review = await second.submit(run.id, { step: 'executors', input: API_EXECUTORS });
    expect(review.step).toBe('review');
    const done = await second.confirm(run.id);
    expect(done.state).toBe('confirmed');
    expect((await rig.config()).roles.preset).toBe('balanced');
  });
});

describe('back', () => {
  it('undoes only the state of the step it leaves', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    const afterDetect = await service.submit(run.id, { step: 'detect', input: {} });
    await service.submit(run.id, { step: 'preset', input: { preset: 'economical' } });
    const back = await service.back(run.id);
    expect(back.step).toBe('preset');
    expect(back.done).toEqual(afterDetect.done);
    expect(await rig.text()).toBe('');
    // It can be answered again, differently.
    const again = await service.submit(run.id, { step: 'preset', input: { preset: 'quality' } });
    expect(again.done[1]).toMatchObject({ step: 'preset', input: { preset: 'quality' } });
    expect(await eventTypes(rig)).toEqual([
      'setup.started',
      'setup.step',
      'setup.step',
      'setup.back',
      'setup.step',
    ]);
  });

  it('goes back from the review to the last answered step, and refuses at the first step', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const review = await toReview(rig, service);
    const back = await service.back(review.id);
    expect(back.step).toBe('executors');
    expect(back.done.map((entry) => entry.step)).toEqual(['detect', 'preset']);
    await service.back(review.id);
    await service.back(review.id);
    await expect(service.back(review.id)).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('cancel', () => {
  it('leaves config.yaml untouched, whether the file existed or not', async () => {
    const existing = '# mine\nlog:\n  level: debug\n';
    const rig = await rigOf({ configYaml: existing });
    const service = rig.service();
    const review = await toReview(rig, service);
    const cancelled = await service.cancel(review.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', prompt: null });
    expect(await rig.text()).toBe(existing);
    await expect(service.confirm(review.id)).rejects.toBeInstanceOf(Conflict);
    expect(await rig.store.executors.list({})).toEqual([]);

    const bare = await rigOf();
    const run = await bare.service().start('first_run');
    await bare.service().cancel(run.id);
    expect(await bare.text()).toBe('');
    expect(await eventTypes(bare)).toEqual(['setup.started', 'setup.cancelled']);
  });

  it('frees the flow for another run, and the overview remembers how the last one ended', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('first_run');
    await service.cancel(run.id);
    const status = (await service.overview()).flows.find((flow) => flow.flow === 'first_run');
    expect(status?.active).toBeNull();
    expect(status?.lastFinished).toMatchObject({ id: run.id, state: 'cancelled' });
    expect((await service.start('first_run')).id).not.toBe(run.id);
    expect((await service.overview()).firstRunNeeded).toBe(true);
  });
});

describe('the confirmation', () => {
  it('writes through the editor of PUT /v1/config: a file the daemon cannot read stays as it was', async () => {
    const broken = 'log: [unclosed\n';
    const rig = await rigOf({ configYaml: broken });
    const service = rig.service();
    // The overview and the start read the file, so a broken one stops the run at the start.
    await expect(service.start('first_run')).rejects.toThrow();
    expect(await rig.text()).toBe(broken);
  });

  it('is safe to repeat: a confirm that stopped halfway finishes the job', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const review = await toReview(rig, service);
    await service.confirm(review.id);
    const written = await rig.text();
    // The same run, confirmed again, is a conflict, and the file does not change.
    await expect(service.confirm(review.id)).rejects.toBeInstanceOf(Conflict);
    expect(await rig.text()).toBe(written);
  });

  it('with setup.role_lists: preset, no list is written: the preset resolves them', async () => {
    const rig = await rigOf({
      configYaml: 'setup:\n  role_lists: preset\n',
    });
    const service = rig.service();
    const review = await toReview(rig, service);
    await service.confirm(review.id);
    const config = await rig.config();
    // Lists left to the preset: no explicit list is written, the preset resolves them.
    expect(config.roles.author?.executors).toBeUndefined();
    expect(config.roles.preset).toBe('quality');
    expect(config.executors.entries[MINIMAX_EXECUTOR]).toBeDefined();
  });

  it('two confirmations at once write once', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const review = await toReview(rig, service);
    const results = await Promise.allSettled([
      service.confirm(review.id),
      service.confirm(review.id),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await eventTypes(rig)).filter((type) => type === 'setup.confirmed')).toHaveLength(1);
  });
});

describe('the other two flows (skeleton)', () => {
  it('change_preset: the preset and the review, and the lists follow the new preset', async () => {
    const rig = await rigOf({ configYaml: 'roles:\n  preset: quality\n' });
    const service = rig.service();
    const run = await service.start('change_preset');
    expect(run.steps).toEqual(['preset', 'review']);
    expect(run.prompt).toMatchObject({ step: 'preset', current: 'quality' });
    const review = await service.submit(run.id, {
      step: 'preset',
      input: { preset: 'economical' },
    });
    expect(review.step).toBe('review');
    await service.confirm(run.id);
    const config = await rig.config();
    expect(config.roles.preset).toBe('economical');
    expect(config.roles.author?.executors).toEqual([
      `claude-sonnet-medium@${CLAUDE}`,
      `codex-sol-medium@${CODEX}`,
    ]);
  });

  it('add_account: the account, its Executors, and the review, over the lists of the file', async () => {
    const rig = await rigOf({
      configYaml: 'roles:\n  preset: quality\n',
      profiles: DEFAULT_PROFILES.slice(0, 1),
    });
    const service = rig.service();
    // First the Executors of the first account, through a change of preset.
    const seed = await service.start('change_preset');
    await service.submit(seed.id, { step: 'preset', input: { preset: 'quality' } });
    await service.confirm(seed.id);
    const before = await rig.config();
    expect(before.roles.author?.executors).toEqual([`claude-opus-high@${CLAUDE}`]);

    // A second account arrives: the flow brings it in without touching the first one's entries.
    await rig.store.profiles.create({
      client: 'codex',
      name: 'main',
      kind: 'token_plan',
      provider: 'openai',
      dir: '/profiles/codex/main',
      secretRef: null,
    });
    const run = await service.start('add_account');
    expect(run.steps).toEqual(['account', 'executors', 'review']);
    await service.submit(run.id, { step: 'account', input: { profileId: CODEX } });
    const review = await service.submit(run.id, { step: 'executors', input: {} });
    if (review.prompt?.step !== 'review') throw new Error('expected the review prompt');
    expect(review.prompt.plan.preset).toBeNull();
    expect(review.prompt.plan.executors.map((executor) => executor.profileId)).toEqual([
      CODEX,
      CODEX,
    ]);
    await service.confirm(run.id);
    const after = await rig.config();
    expect(after.roles.preset).toBe('quality');
    expect(after.executors.entries[`claude-opus-high@${CLAUDE}`]).toBeDefined();
    expect(after.executors.entries[`codex-sol-high@${CODEX}`]).toBeDefined();
    // The lists the file had keep their order and take the new Executor where on_register puts it.
    expect(after.roles.author?.executors).toContain(`claude-opus-high@${CLAUDE}`);
    expect(after.roles.author?.executors).toContain(`codex-sol-high@${CODEX}`);
  });

  it('add_account refuses an account that is not registered', async () => {
    const rig = await rigOf();
    const service = rig.service();
    const run = await service.start('add_account');
    await expect(
      service.submit(run.id, { step: 'account', input: { profileId: 'codex/ghost' } }),
    ).rejects.toBeInstanceOf(InvalidInput);
  });
});
