// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from './ink.test-support.js';
import { parseUiSettings } from './settings.js';
import { startTuiTestDaemon, type TuiTestDaemon } from './test-daemon.test-support.js';

/**
 * The screen of P8 against a real daemon of this process: the stores of the client sync with it
 * and the screen shows its state. Nothing real runs (N57): the store, the clock and the vault are
 * in-memory fakes, no client is found, and the API listens on 127.0.0.1 in a temporary folder.
 */

const daemons: TuiTestDaemon[] = [];

async function startDaemon(configYaml = ''): Promise<TuiTestDaemon> {
  const clock = new FakeClock();
  const daemon = await startTuiTestDaemon(
    { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() },
    configYaml,
  );
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  cleanupApps();
  for (const daemon of daemons.splice(0)) await daemon.dispose();
});

async function open(
  daemon: TuiTestDaemon,
  systemLocale?: string,
  ui?: unknown,
): Promise<RenderedApp> {
  return renderApp({
    connector: daemon.connector,
    settings: parseUiSettings(ui),
    systemLocale,
  });
}

describe('the status screen, with a daemon', () => {
  it('shows the daemon, its state and that the stores are live', async () => {
    const daemon = await startDaemon();
    const app = await open(daemon);
    const frame = await app.waitForText(/Sync\s+live/);
    expect(frame).toMatch(/Daemon\s+0\.0\.0-test, pid \d+/);
    expect(frame).toMatch(/State\s+running/);
    expect(frame).toMatch(/Scenarios\s+\d+/);
    expect(frame).toMatch(/Plays\s+0/);
    expect(frame).not.toContain('No daemon is running');
  });

  it('follows ui.locale of the daemon: starts in English and goes to Portuguese on its own', async () => {
    const daemon = await startDaemon('ui:\n  locale: pt-BR\n');
    const app = await open(daemon, 'en_US.UTF-8');
    const frame = await app.waitForText(/Sincronização\s+ao vivo/);
    expect(frame).toMatch(/Estado\s+rodando/);
    expect(frame).not.toContain('Sync');
  });

  it('keeps the system language while ui.locale of the daemon is auto', async () => {
    const daemon = await startDaemon();
    const app = await open(daemon, 'pt_BR.UTF-8');
    const frame = await app.waitForText(/Sincronização\s+ao vivo/);
    expect(frame).toMatch(/Cenários\s+\d+/);
  });

  it('when the daemon stops, says the stream was lost instead of freezing on the old state', async () => {
    const daemon = await startDaemon();
    const app = await open(daemon);
    await app.waitForText(/Sync\s+live/);
    await daemon.daemon.stop();
    await app.waitForText(/Event stream\s+(retrying|closed)/);
  });
});
