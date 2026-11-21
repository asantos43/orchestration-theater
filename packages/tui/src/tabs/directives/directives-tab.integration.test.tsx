// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../../ink.test-support.js';
import { startTuiTestDaemon, type TuiTestDaemon } from '../../test-daemon.test-support.js';
import { openDirectivesTab } from './directives.test-support.js';

/**
 * The actions of the tab Directives against a real daemon of this process (nothing real runs,
 * N57: in-memory store, fake clock, loopback only). Acceptance of P15: each action changes the
 * state in the tab through the event `directive.*`, with no reload, and no REST read comes after
 * the action. The test watches every request the client sends and asserts there is no `GET`.
 */

interface Sent {
  readonly method: string;
  readonly path: string;
}

let daemon: TuiTestDaemon;
let app: RenderedApp;
let sent: Sent[];
const original = globalThis.fetch;

beforeEach(async () => {
  const clock = new FakeClock(Date.now());
  const store = new InMemoryStore({ clock });
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'software',
    name: 'Billing API',
    folder: '/tmp/billing',
    profile: 'software',
    conventions: {},
    configOverride: {},
  });
  daemon = await startTuiTestDaemon({ clock, store, vault: new InMemorySecretVault() });
  app = await renderApp({
    connector: daemon.connector,
    size: { columns: 230, rows: 70 },
  });
  await app.waitForText('Billing API');
  await openDirectivesTab(app);
  // Everything the client sends from here on is recorded.
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    sent.push({ method: init?.method ?? 'GET', path: url.pathname });
    return original(input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupApps();
  await daemon.dispose();
});

/** One key at a time, as a terminal sends them. */
async function key(keys: string): Promise<string> {
  app.press(keys);
  return app.settle();
}

const reads = (): Sent[] => sent.filter((request) => request.method === 'GET');
const writes = (): string[] =>
  sent.filter((request) => request.method === 'POST').map((request) => request.path);

describe('the tab Directives against a daemon', () => {
  it('gives, extends, suspends and revokes an order, and each change comes by its event, with no read', async () => {
    // Give an order that lasts a day: text, then Tab to the field "Lasts".
    await key('n');
    await app.waitForText('Give an order');
    await key('Answer in short sentences');
    for (let i = 0; i < 5; i += 1) await key('\t');
    await key('1d');
    app.press('\r');
    let frame = await app.waitForText('Order O1 given.');
    expect(frame).not.toContain('Give an order');
    expect(frame).toContain('O1 [instruction] Answer in short sentences');
    expect(frame).toMatch(/ends in 23h/);

    // Extend it by two days: the end moves and the line is drawn again.
    await key('e');
    await app.waitForText('Extend O1');
    for (let i = 0; i < 2; i += 1) await key('\t');
    await key('2d');
    app.press('\r');
    frame = await app.waitForText('Order O1 extended.');
    expect(frame).toMatch(/ends in 2d 23h/);

    // Suspend it in the scenario: a suspension of its own shows under the scenario.
    await key('s');
    await app.waitForText('Suspend O1 Answer in short sentences in a scenario');
    app.press('\r');
    frame = await app.waitForText('Suspension O2 given.');
    expect(frame).toContain('Scenario Billing API');
    expect(frame).toContain('O2 [suspension]');

    // Revoke it: it goes to the ended ones, with its reason.
    await key('r');
    await app.waitForText('Revoke O1');
    await key('the client changed its mind');
    app.press('\r');
    frame = await app.waitForText('Order O1 revoked.');
    const lines = frame.split('\n');
    const ended = lines.findIndex((line) => line.includes('▾ Ended'));
    const revoked = lines.findIndex((line) => line.includes('O1 [instruction]'));
    expect(revoked).toBeGreaterThan(ended);
    // The selection goes to the first order on the screen; the next one is the revoked.
    frame = await key('j');
    expect(frame).toContain('Revoked: the client changed its mind');
    expect(frame).toMatch(/revoked <1m ago/);

    // Four commands went out and none was followed by a read.
    expect(writes()).toEqual([
      '/v1/orders',
      '/v1/orders/O1/extend',
      '/v1/orders/O1/suspend',
      '/v1/orders/O1/revoke',
    ]);
    expect(reads()).toEqual([]);
  });

  it('keeps the form and says why when the daemon refuses', async () => {
    await key('n');
    await app.waitForText('Give an order');
    await key('A rule with a date that is not one');
    for (let i = 0; i < 3; i += 1) await key('\t');
    await key('not a date');
    app.press('\r');
    const frame = await app.waitForText('Not done:');
    expect(frame).toContain('Give an order');
    expect(frame).toContain('not a date');
    expect(reads()).toEqual([]);
    // Esc leaves it; nothing was given.
    app.press('\x1b');
    await waitFor(() => !app.frame().includes('Give an order'), 'the form to close');
    expect(await app.settle()).toContain('No orders yet.');
  });

  it('does not act on a key of the panel while a form has the keyboard', async () => {
    await key('n');
    await app.waitForText('Give an order');
    // Letters that are commands of the panel are text in the form; Left is not a tab change.
    await key('rnes');
    const frame = await key('\x1b[D');
    expect(frame).toContain('Give an order');
    expect(frame).toContain('rnes');
    // Esc closes the form and does not also leave anything else.
    app.press('\x1b');
    await waitFor(() => !app.frame().includes('Give an order'), 'the form to close');
    expect(await app.settle()).toContain('In force');
  });
});
