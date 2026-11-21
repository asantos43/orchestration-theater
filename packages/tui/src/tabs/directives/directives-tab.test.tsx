// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../../layout.test-support.js';
import { DAY, HOUR, openDirectivesTab, order } from './directives.test-support.js';

/**
 * The tab Directives over stores that no network feeds: what it draws from the orders store, how
 * the cursor walks it and what the keys do. The actions against a daemon are in
 * `directives-tab.integration.test.tsx`.
 */

afterEach(cleanupApps);

async function open(
  seed: (online: FakeOnline) => void,
  options: { readonly systemLocale?: string } = {},
): Promise<{ app: RenderedApp; online: FakeOnline; frame: string }> {
  const online = fakeOnline();
  seedStores(online.stores);
  seed(online);
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 230, rows: 60 },
    ...options,
  });
  await app.waitForText(options.systemLocale === undefined ? 'SCENARIOS' : 'CENÁRIOS');
  const frame = await openDirectivesTab(
    app,
    options.systemLocale === undefined
      ? undefined
      : { palette: 'Paleta de comandos', tab: 'Diretrizes', section: 'Vigentes' },
  );
  return { app, online, frame };
}

function scenarioIds(online: FakeOnline): string[] {
  return Object.keys(online.stores.scenarios.getState().byId);
}

function put(
  online: FakeOnline,
  orders: Parameters<typeof order>[0][] | ReturnType<typeof order>[],
) {
  const list = orders.map((item) => (typeof item === 'string' ? order(item) : item));
  online.stores.orders.setState({ byId: Object.fromEntries(list.map((item) => [item.id, item])) });
}

describe('what the tab draws', () => {
  it('shows an empty state with the key that gives the first order', async () => {
    const { frame } = await open(() => undefined);
    expect(frame).toContain('No orders yet. Press N to give the first one.');
    expect(frame).toContain('In force');
    expect(frame).toContain('Scheduled');
    expect(frame).toContain('Ended');
    expect(frame).toContain('N give');
  });

  it('puts the orders in force, scheduled and ended in their sections, by scope, with the deadlines', async () => {
    const now = Date.now();
    const { frame } = await open((online) => {
      const [first] = scenarioIds(online);
      put(online, [
        order('O1', { text: 'Reply in short sentences', endsAt: now + 2 * DAY + 3 * HOUR }),
        order('O2', {
          text: 'Only the tests of the module',
          scope: 'local',
          scenarioId: first ?? null,
          kind: 'rule',
          ruleKey: 'plays.parallel',
          ruleValue: 2,
        }),
        order('O3', {
          text: 'Freeze the schema',
          state: 'scheduled',
          startsAt: now + 5 * HOUR,
          endsAt: now + DAY,
        }),
        order('O4', {
          text: 'Old rule',
          state: 'expired',
          startsAt: now - 3 * DAY,
          endsAt: now - 2 * DAY,
        }),
        order('O5', {
          text: 'Wrong order',
          state: 'revoked',
          revokedAt: now - 2 * HOUR,
          revokeReason: 'it was a mistake',
        }),
      ]);
    });
    const lines = frame.split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('▾ In force')).toBeLessThan(at('▾ Scheduled'));
    expect(at('▾ Scheduled')).toBeLessThan(at('▾ Ended'));
    expect(at('O1')).toBeGreaterThan(at('▾ In force'));
    expect(at('O1')).toBeLessThan(at('▾ Scheduled'));
    expect(at('O3')).toBeGreaterThan(at('▾ Scheduled'));
    expect(at('O3')).toBeLessThan(at('▾ Ended'));
    expect(at('O4')).toBeGreaterThan(at('▾ Ended'));
    expect(at('O5')).toBeLessThan(at('O4'));
    expect(frame).toContain('Global');
    expect(frame).toContain('Scenario Billing API');
    expect(frame).toContain('[rule] Only the tests of the module');
    expect(frame).toMatch(/ends in 2d 2h/);
    expect(frame).toMatch(/starts in 4h 5\dm|starts in 5h/);
    expect(frame).toMatch(/ended 2d ago/);
    expect(frame).toMatch(/revoked 2h ago/);
    // The counts of the sections.
    expect(lines[at('▾ In force')]).toMatch(/In force\s+2/);
    expect(lines[at('▾ Scheduled')]).toMatch(/Scheduled\s+1/);
    expect(lines[at('▾ Ended')]).toMatch(/Ended\s+2/);
  });

  it('draws the timeline of the validity: the dates in the zone of the order, the bar and the open end', async () => {
    const now = Date.now();
    const { frame } = await open((online) => {
      put(online, [
        order('O1', { startsAt: now - HOUR, endsAt: now + HOUR }),
        order('O2', { text: 'No end', startsAt: now - HOUR, endsAt: null }),
      ]);
    });
    expect(frame).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d [█░]{16} \d{4}-\d\d-\d\d \d\d:\d\d/);
    expect(frame).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d ━+→ until revoked/);
    expect(frame).toContain('until revoked');
  });

  it('announces an order that is about to end', async () => {
    const now = Date.now();
    const { frame } = await open((online) => {
      put(online, [order('O1', { endsAt: now + 20 * 60_000 })]);
      online.stores.orders.setState({
        expiring: { O1: { endsAt: now + 20 * 60_000, noticeMs: 30 * 60_000 } },
      });
    });
    expect(frame).toMatch(/ending soon: 1\dm|ending soon: 20m/);
  });

  it('shows the details of the selected order: roles, the rule, what it suspends, the reason of a revocation', async () => {
    const now = Date.now();
    const { app, frame } = await open((online) => {
      put(online, [
        order('O1', { text: 'Be brief', roles: ['writer', 'reviewer'] }),
        order('O2', {
          text: 'Suspend O1 here',
          kind: 'suspension',
          scope: 'local',
          scenarioId: scenarioIds(online)[0] ?? null,
          suspendsId: 'O1',
        }),
        order('O3', {
          text: 'Wrong',
          state: 'revoked',
          revokedAt: now,
          revokeReason: 'it was a mistake',
        }),
      ]);
    });
    expect(frame).toContain('Roles: writer, reviewer');
    expect(frame).toContain('Time zone America/Sao_Paulo');
    expect(frame).toContain('Given by tui');
    app.press('\x1b[1;2B');
    const second = await app.settle();
    expect(second).toContain('Takes O1 out of the scenario');
    expect(second).toContain('Roles: all');
    expect(second).not.toContain('Roles: writer');
    app.press('\x1b[1;2B');
    const third = await app.settle();
    expect(third).toContain('Revoked: it was a mistake');
  });

  it('draws in Portuguese when the language is', async () => {
    const { frame } = await open(() => undefined, { systemLocale: 'pt_BR.UTF-8' });
    expect(frame).toContain('Vigentes');
    expect(frame).toContain('Agendadas');
    expect(frame).toContain('Encerradas');
  });
});

describe('the selection', () => {
  it('walks the orders on the screen with Shift+Down and Shift+Up and stops at the ends', async () => {
    const { app } = await open((online) => {
      put(online, ['O1', 'O2', 'O3']);
    });
    const marked = (frame: string): string | undefined =>
      frame.split('\n').find((line) => /› O\d/.test(line));
    expect(marked(await app.settle())).toContain('O1');
    app.press('\x1b[1;2B');
    expect(marked(await app.settle())).toContain('O2');
    app.press('j');
    expect(marked(await app.settle())).toContain('O3');
    app.press('j');
    expect(marked(await app.settle())).toContain('O3');
    app.press('\x1b[1;2A');
    expect(marked(await app.settle())).toContain('O2');
    app.press('k');
    app.press('k');
    expect(marked(await app.settle())).toContain('O1');
  });

  it('keeps a valid selection when the order selected goes away', async () => {
    const { app, online } = await open((seeded) => {
      put(seeded, ['O1', 'O2']);
    });
    app.press('\x1b[1;2B');
    await app.settle();
    online.stores.orders.setState({ byId: { O1: order('O1') } });
    const frame = await app.settle();
    expect(frame.split('\n').find((line) => /› O\d/.test(line))).toContain('O1');
  });

  it('skips the orders of a section that is folded', async () => {
    const now = Date.now();
    const { app } = await open((online) => {
      put(online, [
        order('O1'),
        order('O2', { state: 'scheduled', startsAt: now + HOUR, endsAt: null }),
      ]);
    });
    // The cursor of the panel is on the first section: Enter folds it.
    app.press('\r');
    const frame = await app.waitForText('▸ In force');
    expect(frame).not.toContain('O1 [');
    expect(frame.split('\n').find((line) => /› O\d/.test(line))).toContain('O2');
  });
});

describe('the keys that need a selection', () => {
  it('tell the person when there is no order to act on', async () => {
    const { app } = await open(() => undefined);
    app.press('e');
    expect(await app.waitForText('Select an order first.')).not.toContain('Extend O');
    app.press('r');
    await app.settle();
    expect(await app.settle()).toContain('Select an order first.');
  });

  it('refuse to suspend an order that is not global, or to act on one that is revoked', async () => {
    const { app } = await open((online) => {
      put(online, [
        order('O1', { scope: 'local', scenarioId: scenarioIds(online)[0] ?? null }),
        order('O2', { state: 'revoked', revokedAt: Date.now(), revokeReason: 'x' }),
      ]);
    });
    app.press('s');
    await app.waitForText('Only a global order can be suspended in a scenario.');
    app.press('\x1b[1;2B');
    await app.settle();
    app.press('r');
    await app.waitForText('The order is already revoked.');
  });
});

describe('the forms', () => {
  it('open on the key, show the fields of the choice, and say what is missing without sending', async () => {
    const { app, online } = await open(() => undefined);
    // Nothing may go out: the stores are not connected to a daemon.
    app.press('n');
    let frame = await app.waitForText('Give an order');
    expect(frame).toContain('Text: ');
    expect(frame).toContain('Scope: ‹ global ›');
    expect(frame).not.toContain('Scenario: ‹');
    expect(frame).toContain('Tab next field  Enter send  Esc cancel');
    app.press('\r');
    frame = await app.waitForText('Write the text of the order.');
    expect(frame).toContain('Give an order');
    // Scope is a choice: Right makes it "one scenario" and the scenario field shows up.
    app.press('\t');
    await app.settle();
    app.press('\x1b[C');
    frame = await app.waitForText('Scope: ‹ one scenario ›');
    expect(frame).toContain('Scenario: ‹ ');
    expect(frame).toContain('←/→ change');
    expect(online.stores.orders.getState().byId).toEqual({});
    // A lone Esc is held back a moment by the input of Ink, in case it starts a sequence.
    app.press('\x1b');
    await waitFor(() => !app.frame().includes('Give an order'), 'the form to close');
  });

  it('title the form of an order with its id and the start of its text', async () => {
    const { app } = await open((online) => {
      put(online, [order('O1', { text: 'Reply in short sentences' })]);
    });
    app.press('e');
    const frame = await app.waitForText('Extend O1 Reply in short sentences');
    expect(frame).toContain('Until revoked: ‹ no ›');
    app.press('\x1b');
    await waitFor(() => !app.frame().includes('Extend O1'), 'the form to close');
    app.press('r');
    await app.waitForText('Revoke O1 Reply in short sentences');
    app.press('\r');
    await app.waitForText('Say why the order is revoked.');
  });
});
