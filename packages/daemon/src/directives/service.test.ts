// SPDX-License-Identifier: MPL-2.0
import { assemblePrefix, type DirectiveRecord, type EventEnvelope } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { buildDaemonRegistries } from '../registries.js';
import { ToolFailure } from '../mcp/handlers.js';
import { DirectiveService } from './service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-17 12:00 UTC, which is 09:00 in São Paulo. */
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const NOTICE = DAY;

const registries = buildDaemonRegistries();
const started: DirectiveService[] = [];

function setup(options: { notice?: number } = {}): {
  clock: FakeClock;
  store: InMemoryStore;
  service: DirectiveService;
  another: () => DirectiveService;
} {
  const clock = new FakeClock(T0);
  const store = new InMemoryStore({ clock });
  const make = (): DirectiveService => {
    const service = new DirectiveService({
      store,
      clock,
      ruleKeys: registries.ruleKeys,
      settings: { timezone: 'America/Sao_Paulo', expiringNoticeMs: options.notice ?? NOTICE },
      logger: createSilentLogger(),
    });
    started.push(service);
    return service;
  };
  return { clock, store, service: make(), another: make };
}

async function eventsOf(store: InMemoryStore, prefix = 'directive.'): Promise<EventEnvelope[]> {
  return (await store.events.readFrom(0, 1000)).filter((e) => e.type.startsWith(prefix));
}

async function failure(promise: Promise<unknown>): Promise<ToolFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolFailure);
    return error as ToolFailure;
  }
  throw new Error('expected a failure');
}

const ids = (list: readonly DirectiveRecord[]): string[] => list.map((d) => d.id);

afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
});

describe('DirectiveService, orders in force (architecture 5.17)', () => {
  it('a global and a local order are in force, each where it belongs, and are announced', async () => {
    const { service, store } = setup();
    const global = await service.create({ text: 'Always write tests.', scope: 'global' });
    const local = await service.create({
      text: 'Use pnpm here.',
      scope: 'local',
      scenarioId: 's1',
    });
    expect(ids(await service.inForce('s1'))).toEqual([global.id, local.id]);
    expect(ids(await service.inForce('s2'))).toEqual([global.id]);
    const created = await eventsOf(store, 'directive.created');
    expect(created.map((e) => e.payload.directiveId)).toEqual([global.id, local.id]);
    expect(created[1]?.scenarioId).toBe('s1');
  });

  it('puts the orders in the prefix of a session', async () => {
    const { service } = setup();
    await service.create({
      text: 'Never touch the migrations folder.',
      scope: 'global',
      validity: { until: '2026-11-20 18:00' },
    });
    await service.create({ text: 'Prefer small commits.', scope: 'local', scenarioId: 's1' });
    const prefix = assemblePrefix({
      role: 'actor',
      rolePrompt: 'You are the Actor.',
      tools: registries.tools.list(),
      directives: await service.inForce('s1', 'actor'),
    });
    expect(prefix).toContain('Never touch the migrations folder.');
    expect(prefix).toContain('(until 2026-11-20 18:00 America/Sao_Paulo)');
    expect(prefix).toContain('Prefer small commits.');
  });

  it('survives a restart: another service over the same store sees the same orders', async () => {
    const { service, another } = setup();
    await service.create({ text: 'Be brief.', scope: 'global' });
    await service.create({ text: 'Local one.', scope: 'local', scenarioId: 's1' });
    await service.stop();
    const restarted = another();
    await restarted.start();
    expect((await restarted.inForce('s1')).map((d) => d.text)).toEqual(['Be brief.', 'Local one.']);
  });

  it('keeps a future order out until its start, then activates it with the real start time', async () => {
    const { service, clock, store } = setup();
    const order = await service.create({
      text: 'Freeze on Friday.',
      scope: 'global',
      validity: { from: '2026-11-19 09:00' },
    });
    expect(order.state).toBe('scheduled');
    expect(await service.inForce('s1')).toEqual([]);

    await clock.advance(2 * DAY + 3 * HOUR);
    expect(ids(await service.inForce('s1'))).toEqual([order.id]);
    const activated = await eventsOf(store, 'directive.activated');
    expect(activated).toHaveLength(1);
    expect(activated[0]?.payload).toEqual({
      directiveId: order.id,
      effectiveAt: Date.UTC(2026, 10, 19, 12, 0, 0),
    });
    // A second look does not repeat the event.
    await service.sync();
    expect(await eventsOf(store, 'directive.activated')).toHaveLength(1);
  });

  it('keeps out of new sessions an order that expired while the daemon was stopped', async () => {
    const { service, clock, store, another } = setup();
    const order = await service.create({
      text: 'Until 11:00.',
      scope: 'global',
      validity: { for: '2h' },
    });
    await service.stop();
    await clock.advance(5 * HOUR);

    const restarted = another();
    await restarted.start();
    expect(await restarted.inForce('s1')).toEqual([]);
    const expired = await eventsOf(store, 'directive.expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.payload).toEqual({ directiveId: order.id, effectiveAt: T0 + 2 * HOUR });
    expect(expired[0]?.timestamp).toBe(T0 + 5 * HOUR);
  });

  it('a local suspension takes the global order out of that scenario only', async () => {
    const { service, store } = setup();
    const global = await service.create({ text: 'Run the linter.', scope: 'global' });
    const other = await service.create({ text: 'Keep it short.', scope: 'global' });
    const suspension = await service.create({
      text: 'Not in this scenario.',
      scope: 'local',
      scenarioId: 's1',
      kind: 'suspension',
      suspendsId: global.id,
    });
    expect(ids(await service.inForce('s1'))).toEqual([other.id, suspension.id]);
    expect(ids(await service.inForce('s2'))).toEqual([global.id, other.id]);
    const suspended = await eventsOf(store, 'directive.suspended');
    expect(suspended[0]?.payload).toEqual({
      directiveId: suspension.id,
      suspendsId: global.id,
      scenarioId: 's1',
    });
  });

  it('a revoked rule gives back the value of the configuration', async () => {
    const { service } = setup();
    expect(await service.rule('delivery.mode', 'direct_merge', 's1')).toBe('direct_merge');
    const rule = await service.create({
      text: 'Everything goes by pull request.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
    expect(await service.rule('delivery.mode', 'direct_merge', 's1')).toBe('pr');
    await service.revoke(rule.id, 'The Producer changed their mind.');
    expect(await service.rule('delivery.mode', 'direct_merge', 's1')).toBe('direct_merge');
  });

  it('a rule stops applying when it expires', async () => {
    const { service, clock } = setup();
    await service.create({
      text: 'PR for a day.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
      validity: { for: '1d' },
    });
    expect(await service.rule('delivery.mode', 'ask', 's1')).toBe('pr');
    await clock.advance(DAY);
    expect(await service.rule('delivery.mode', 'ask', 's1')).toBe('ask');
  });

  it('builds the "Orders in force now" section of a continuation package from the current orders', async () => {
    const { service, clock } = setup();
    await service.create({ text: 'Short term.', scope: 'global', validity: { for: '1h' } });
    await service.create({ text: 'Long term.', scope: 'global' });
    expect(await service.continuationOrders('s1', 'actor')).toContain('Short term.');
    await clock.advance(2 * HOUR);
    const later = await service.continuationOrders('s1', 'actor');
    expect(later).toContain('## Orders in force now');
    expect(later).not.toContain('Short term.');
    expect(later).toContain('Long term.');
  });
});

describe('DirectiveService, validation', () => {
  it('refuses a rule on a key that is not one of the closed list, and a bad value', async () => {
    const { service } = setup();
    const unknown = await failure(
      service.create({
        text: 'x',
        scope: 'global',
        kind: 'rule',
        ruleKey: 'security.sandbox',
        ruleValue: 'off',
      }),
    );
    expect(unknown.code).toBe('unknown_rule_key');
    expect(unknown.message).toContain('delivery.mode');
    const badValue = await failure(
      service.create({
        text: 'x',
        scope: 'global',
        kind: 'rule',
        ruleKey: 'delivery.mode',
        ruleValue: 'yolo',
      }),
    );
    expect(badValue.code).toBe('invalid_rule_value');
  });

  it('refuses two rules on the same key, scope and overlapping validity, naming the first', async () => {
    const { service } = setup();
    const first = await service.create({
      text: 'PR.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
    const clash = await failure(
      service.create({
        text: 'Merge.',
        scope: 'global',
        kind: 'rule',
        ruleKey: 'delivery.mode',
        ruleValue: 'direct_merge',
      }),
    );
    expect(clash.code).toBe('conflict');
    expect(clash.details.conflicts).toEqual([first.id]);

    // Another scope, another validity or the same value is no clash.
    await service.create({
      text: 'Local merge.',
      scope: 'local',
      scenarioId: 's1',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'direct_merge',
    });
    // The first rule has no end, so a later one with another value still overlaps it.
    const later = await failure(
      service.create({
        text: 'Later merge.',
        scope: 'global',
        kind: 'rule',
        ruleKey: 'delivery.mode',
        ruleValue: 'ask',
        validity: { from: '2027-01-01' },
      }),
    );
    expect(later.code).toBe('conflict');
    await service.create({
      text: 'Same value.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
  });

  it('lets a rule replace another: the old one is revoked and the new one wins', async () => {
    const { service } = setup();
    const first = await service.create({
      text: 'PR.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
    const second = await service.create({
      text: 'Ask.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'ask',
      replacesId: first.id,
    });
    expect((await service.get(first.id))?.state).toBe('revoked');
    expect(await service.rule('delivery.mode', 'direct_merge', 's1')).toBe('ask');
    expect(second.replacesId).toBe(first.id);
  });

  it('treats a rule about another role as no clash', async () => {
    const { service } = setup();
    const one = {
      text: 'x',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'roles.when_exhausted',
    } as const;
    await service.create({ ...one, ruleValue: { role: 'actor', mode: 'wait' } });
    await service.create({ ...one, ruleValue: { role: 'critic', mode: 'next' } });
    const clash = await failure(
      service.create({ ...one, ruleValue: { role: 'actor', mode: 'next' } }),
    );
    expect(clash.code).toBe('conflict');
  });

  it('refuses a suspension of an order that is not global, or does not exist', async () => {
    const { service } = setup();
    const local = await service.create({ text: 'l', scope: 'local', scenarioId: 's1' });
    expect(
      (
        await failure(
          service.create({
            text: 'x',
            scope: 'local',
            scenarioId: 's1',
            kind: 'suspension',
            suspendsId: local.id,
          }),
        )
      ).code,
    ).toBe('invalid_input');
    expect(
      (
        await failure(
          service.create({
            text: 'x',
            scope: 'local',
            scenarioId: 's1',
            kind: 'suspension',
            suspendsId: 'O99',
          }),
        )
      ).code,
    ).toBe('not_found');
  });

  it('reads dates in the time zone of the order, and a bare end date covers the whole day', async () => {
    const { service } = setup();
    const order = await service.create({
      text: 'Through the 20th.',
      scope: 'global',
      validity: { until: '2026-11-20' },
    });
    // 2026-11-21 00:00 in São Paulo (UTC-3).
    expect(order.endsAt).toBe(Date.UTC(2026, 10, 21, 3, 0, 0));
    const bad = await failure(
      service.create({ text: 'x', scope: 'global', validity: { until: 'next week' } }),
    );
    expect(bad.code).toBe('invalid_date');
    expect(
      (
        await failure(
          service.create({ text: 'x', scope: 'global', validity: { for: '2 fortnights' } }),
        )
      ).code,
    ).toBe('invalid_duration');
    expect(
      (
        await failure(
          service.create({
            text: 'x',
            scope: 'global',
            validity: { from: '2026-11-20', until: '2026-11-19' },
          }),
        )
      ).code,
    ).toBe('invalid_validity');
  });
});

describe('DirectiveService, extend and revoke', () => {
  it('extends the end and records the old and the new validity', async () => {
    const { service, store } = setup();
    const order = await service.create({ text: 't', scope: 'global', validity: { for: '1d' } });
    const extended = await service.extend(order.id, { for: '2d' });
    expect(extended.endsAt).toBe((order.endsAt ?? 0) + 2 * DAY);
    const changed = await eventsOf(store, 'directive.validity_changed');
    expect(changed[0]?.payload).toMatchObject({
      directiveId: order.id,
      previousEndsAt: order.endsAt,
      endsAt: extended.endsAt,
    });
    const open = await service.extend(order.id, { until: null });
    expect(open.endsAt).toBeNull();
  });

  it('brings back to life an order that had expired, with an activation at the moment of the extension', async () => {
    const { service, clock, store } = setup();
    const order = await service.create({ text: 't', scope: 'global', validity: { for: '1h' } });
    await clock.advance(2 * HOUR);
    expect(await service.inForce('s1')).toEqual([]);
    await service.extend(order.id, { for: '5h' });
    expect(ids(await service.inForce('s1'))).toEqual([order.id]);
    const activated = await eventsOf(store, 'directive.activated');
    expect(activated.at(-1)?.payload.effectiveAt).toBe(clock.now());
  });

  it('revokes for good, with the reason, and refuses a second revocation or an empty reason', async () => {
    const { service, store } = setup();
    const order = await service.create({ text: 't', scope: 'global' });
    expect((await failure(service.revoke(order.id, '  '))).code).toBe('invalid_input');
    const revoked = await service.revoke(order.id, 'Not needed any more.');
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokeReason).toBe('Not needed any more.');
    expect((await failure(service.revoke(order.id, 'again'))).code).toBe('conflict');
    expect((await failure(service.extend(order.id, { for: '1d' }))).code).toBe('conflict');
    expect((await failure(service.revoke('O99', 'x'))).code).toBe('not_found');
    const events = await eventsOf(store, 'directive.revoked');
    expect(events[0]?.payload).toMatchObject({
      directiveId: order.id,
      reason: 'Not needed any more.',
    });
  });
});

describe('DirectiveService, drafts', () => {
  const context = { scenarioId: 's1' };

  it('a proposal is only a draft: the order exists after the Producer confirms it', async () => {
    const { service, store } = setup();
    const draft = await service.proposeCreate(
      { text: 'Review every PR twice.', scope: 'global', validity: { for: '3d' } },
      context,
    );
    expect(draft.preview).toMatchObject({ action: 'create', scope: 'global', kind: 'instruction' });
    expect(await service.list()).toEqual([]);
    expect(await eventsOf(store)).toEqual([]);
    expect((await service.listDrafts('s1')).map((d) => d.draftId)).toEqual([draft.draftId]);

    const { directive } = await service.confirmDraft(draft.draftId, { origin: 'chat' });
    expect(directive.text).toBe('Review every PR twice.');
    expect(directive.origin).toBe('chat');
    expect(ids(await service.inForce('s9'))).toEqual([directive.id]);
    expect(await service.listDrafts()).toEqual([]);
    expect((await failure(service.confirmDraft(draft.draftId))).code).toBe('conflict');
  });

  it('the Producer can edit the text and the validity when confirming, or cancel', async () => {
    const { service } = setup();
    const draft = await service.proposeCreate({ text: 'Draft text.', scope: 'global' }, context);
    const { directive } = await service.confirmDraft(draft.draftId, {
      edits: { text: 'Edited text.', validity: { for: '1d' } },
    });
    expect(directive.text).toBe('Edited text.');
    expect(directive.endsAt).toBe(directive.startsAt + DAY);

    const second = await service.proposeCreate({ text: 'Nope.', scope: 'global' }, context);
    await service.cancelDraft(second.draftId);
    expect(await service.listDrafts()).toEqual([]);
    expect((await failure(service.confirmDraft(second.draftId))).code).toBe('conflict');
    expect((await failure(service.confirmDraft('draft-nope'))).code).toBe('not_found');
  });

  it('shows the order a rule draft clashes with and refuses to confirm it', async () => {
    const { service } = setup();
    const first = await service.create({
      text: 'PR.',
      scope: 'global',
      kind: 'rule',
      ruleKey: 'delivery.mode',
      ruleValue: 'pr',
    });
    const draft = await service.proposeCreate(
      { text: 'Ask.', scope: 'global', kind: 'rule', ruleKey: 'delivery.mode', ruleValue: 'ask' },
      context,
    );
    expect(draft.conflicts).toEqual([first.id]);
    expect((await failure(service.confirmDraft(draft.draftId))).code).toBe('conflict');
    // The draft stays pending, so the Producer can still cancel it.
    expect(await service.listDrafts()).toHaveLength(1);
  });

  it('extend and revoke drafts change nothing until confirmed', async () => {
    const { service } = setup();
    const order = await service.create({ text: 't', scope: 'global', validity: { for: '1d' } });
    const extend = await service.proposeExtend(order.id, { for: '1d' }, context);
    expect(extend.preview).toMatchObject({ action: 'extend', directiveId: order.id });
    const revoke = await service.proposeRevoke(order.id, 'done', context);
    expect((await service.get(order.id))?.endsAt).toBe(order.endsAt);

    await service.confirmDraft(extend.draftId);
    expect((await service.get(order.id))?.endsAt).toBe((order.endsAt ?? 0) + DAY);
    await service.confirmDraft(revoke.draftId);
    expect((await service.get(order.id))?.state).toBe('revoked');
  });
});

describe('DirectiveService, the notice and the watcher', () => {
  it('writes the "ends soon" notice once, 24 hours before the end, and not again after a restart', async () => {
    const { service, clock, store, another } = setup();
    const order = await service.create({ text: 't', scope: 'global', validity: { for: '3d' } });
    await clock.advance(DAY);
    await service.sync();
    expect(await eventsOf(store, 'directive.expiring')).toHaveLength(0);
    await clock.advance(DAY + HOUR);
    await service.sync();
    await service.sync();
    const notices = await eventsOf(store, 'directive.expiring');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      directiveId: order.id,
      endsAt: order.endsAt,
      noticeMs: NOTICE,
    });
    const restarted = another();
    await restarted.start();
    expect(await eventsOf(store, 'directive.expiring')).toHaveLength(1);
  });

  it('gives no notice to an order shorter than the notice, nor when the notice is off', async () => {
    const short = setup();
    await short.service.create({ text: 't', scope: 'global', validity: { for: '2h' } });
    await short.clock.advance(HOUR);
    await short.service.sync();
    expect(await eventsOf(short.store, 'directive.expiring')).toHaveLength(0);

    const off = setup({ notice: 0 });
    await off.service.create({ text: 't', scope: 'global', validity: { for: '3d' } });
    await off.clock.advance(3 * DAY - HOUR);
    await off.service.sync();
    expect(await eventsOf(off.store, 'directive.expiring')).toHaveLength(0);
  });

  it('the watcher writes the events at the boundary without anyone asking', async () => {
    const { service, clock, store } = setup({ notice: 0 });
    await service.start();
    const order = await service.create({
      text: 'Short.',
      scope: 'global',
      validity: { from: '2026-11-17 10:00', for: '1h' },
    });
    expect(order.state).toBe('scheduled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clock.advance(HOUR);
    await waitFor(async () => (await eventsOf(store, 'directive.activated')).length === 1);
    await clock.advance(HOUR);
    await waitFor(async () => (await eventsOf(store, 'directive.expired')).length === 1);
    expect((await eventsOf(store, 'directive.expired'))[0]?.payload).toEqual({
      directiveId: order.id,
      effectiveAt: order.endsAt,
    });
    await service.stop();
    expect(clock.pendingSleeps).toBe(0);
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}
