// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_ROUTES } from '@otheater/protocol';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupApps,
  renderApp,
  TEST_UI_SETTINGS,
  waitFor,
  type RenderedApp,
} from '../ink.test-support.js';
import { startTuiTestDaemon, type TuiTestDaemon } from '../test-daemon.test-support.js';

/**
 * The acceptance of the assistant in the TUI (P17 of Phase 7), against a real daemon of this
 * process: the TUI draws the steps the daemon holds, the keys travel the real routes of the
 * assistant, the file is the one the daemon writes and the events are the ones it emits. Nothing
 * real runs (N57): in-memory store, clock and vault, fake accounts that were never logged in, no
 * client found, loopback only, a temporary data folder. No test reads a credential.
 */

const SETTINGS = {
  ...TEST_UI_SETTINGS,
  setup: { ...TEST_UI_SETTINGS.setup, open: 'auto' as const },
};
const SIZE = { columns: 140, rows: 50 };
const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';

const daemons: TuiTestDaemon[] = [];

async function startDaemon(): Promise<{ daemon: TuiTestDaemon; store: InMemoryStore }> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  for (const [client, name, provider] of [
    ['claude-code', 'main', 'anthropic'],
    ['codex', 'work', 'openai'],
  ] as const) {
    await store.profiles.create({
      client,
      name,
      kind: 'token_plan',
      provider,
      dir: `/profiles/${client}/${name}`,
      secretRef: null,
    });
  }
  const daemon = await startTuiTestDaemon({ clock, store, vault: new InMemorySecretVault() });
  daemons.push(daemon);
  return { daemon, store };
}

afterEach(async () => {
  cleanupApps();
  for (const daemon of daemons.splice(0)) await daemon.dispose();
});

async function configFile(daemon: TuiTestDaemon): Promise<string> {
  return readFile(join(daemon.dataDir, 'config.yaml'), 'utf8').catch(() => '');
}

async function openTui(daemon: TuiTestDaemon): Promise<RenderedApp> {
  return renderApp({ connector: daemon.connector, size: SIZE, settings: SETTINGS });
}

/** One key at a time, as a terminal sends them: the app has handled it before the next. */
async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

describe('the setup assistant of the TUI, with a daemon', () => {
  it('goes from scratch to the confirmation with the keys alone, and writes the configuration', async () => {
    const { daemon } = await startDaemon();
    const watcher = await daemon.connector.connect();
    if (watcher.kind !== 'online') throw new Error('the daemon is not online');
    try {
      await watcher.daemon.stores.start();
      const app = await openTui(daemon);
      // No configuration: the TUI opens straight in the assistant, with no key pressed.
      const detect = await app.waitForText('Setup assistant: first run');
      await app.waitForText('Pick the accounts that take part');
      expect(detect).not.toContain('SCENARIOS');
      expect(app.frame()).toContain('claude-code/main');
      expect(app.frame()).toContain('codex/work');
      expect(await configFile(daemon)).toBe('');

      await key(app, ENTER);
      await app.waitForText('Pick the preset of the roles.');
      expect(app.frame()).toMatch(/›balanced/);
      await key(app, UP);
      await key(app, ENTER);
      await app.waitForText('Register Executors by API or local model');
      await key(app, ENTER);
      const review = await app.waitForText('This is what will be written.');
      expect(review).toContain('Preset: quality');
      // Nothing is written before the confirmation.
      expect(await configFile(daemon)).not.toContain('quality');

      await key(app, ENTER);
      const done = await app.waitForText('Done. The configuration was written.');
      expect(done).toContain('Preset: quality');
      expect(await configFile(daemon)).toMatch(/preset:\s*quality/);
      await waitFor(
        () =>
          watcher.daemon.stores.events
            .getState()
            .events.some((event) => event.type === 'setup.confirmed') || undefined,
        'the event setup.confirmed',
      );

      // Enter closes the assistant and the layout is back; the daemon no longer asks for a first run.
      await key(app, ENTER);
      await app.waitForText('SCENARIOS');
      expect(app.frame()).not.toContain('Setup assistant');
    } finally {
      watcher.daemon.close();
    }
  }, 30_000);

  it('closing the TUI midway and opening it again returns to the same step', async () => {
    const { daemon } = await startDaemon();
    const first = await openTui(daemon);
    await first.waitForText('Pick the accounts that take part');
    // Take the second account out of the run, then answer: the daemon holds that answer.
    await key(first, 'j');
    await key(first, ' ');
    await key(first, ENTER);
    await first.waitForText('Pick the preset of the roles.');
    await key(first, ENTER);
    await first.waitForText('Register Executors by API or local model');
    first.unmount();

    const second = await openTui(daemon);
    const resumed = await second.waitForText(
      'Resuming the run you left midway, at the step Executors.',
    );
    expect(resumed).toContain('Step 3 of 4');
    // Back reaches the steps the daemon kept, each one drawn again from the daemon.
    await key(second, ESC);
    await second.waitForText('Pick the preset of the roles.');
    await key(second, ESC);
    await second.waitForText('Pick the accounts that take part');
    // Nothing was written by leaving, and no run was started twice.
    expect(await configFile(daemon)).toBe('');
    const watcher = await daemon.connector.connect();
    if (watcher.kind !== 'online') throw new Error('the daemon is not online');
    try {
      const overview = await watcher.daemon.stores.client.call(API_ROUTES.getSetup, {});
      expect(overview.flows.find((flow) => flow.flow === 'first_run')?.active?.step).toBe('detect');
    } finally {
      watcher.daemon.close();
    }
  }, 30_000);

  it('add account and change preset open from the Settings tab and end in the configuration', async () => {
    const { daemon } = await startDaemon();
    const app = await openTui(daemon);
    // Leave the first run midway: the run stays, and the layout is the one under it.
    await app.waitForText('Pick the accounts that take part');
    await key(app, ESC);
    await app.waitForText('SCENARIOS');
    app.press('\x1b[15~');
    await app.waitForText('claude-code/main');

    app.press('p');
    await app.waitForText('Setup assistant: change the preset');
    await app.waitForText('Pick the preset of the roles.');
    await key(app, UP);
    await key(app, ENTER);
    await app.waitForText('Preset: quality');
    await key(app, ENTER);
    await app.waitForText('Done. The configuration was written.');
    await key(app, ENTER);
    await app.waitForText('SCENARIOS');
    expect(await configFile(daemon)).toMatch(/preset:\s*quality/);

    app.press('w');
    await app.waitForText('Setup assistant: add an account');
    await app.waitForText('Pick the account to bring into the roles.');
    expect(app.frame()).toContain('Step 1 of 3');
  }, 30_000);

  it('shows the daemon error as the daemon said it', async () => {
    const { daemon } = await startDaemon();
    const app = await openTui(daemon);
    await app.waitForText('Pick the accounts that take part');
    await key(app, ENTER);
    await app.waitForText('Pick the preset of the roles.');
    await key(app, ENTER);
    await app.waitForText('Register Executors by API or local model');
    // An account the daemon does not know: the screen lets the line through and the daemon refuses it.
    await key(app, 'a');
    for (const char of 'nobody/here some-model') await key(app, char);
    await key(app, ENTER);
    await key(app, ENTER);
    const frame = await app.waitForText('Refused by the daemon');
    expect(frame).toMatch(/nobody\/here/);
    expect(frame).toContain('● Executors');
  }, 30_000);
});
