// SPDX-License-Identifier: MPL-2.0
import { API_VERSION } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, TEST_UI_SETTINGS } from '../ink.test-support.js';
import { fakeOnline, seedStores } from '../layout.test-support.js';
import type { UiSettings } from '../settings.js';
import { bannerOf } from './use-security-status.js';

/**
 * The fixed row about the protection (N334, 2026-11-26; [proposta]): it shows only without layer 3,
 * says the Director will not open under `refuse` and that the protection is reduced under `warn` or
 * `allow`, and `ui.security.banner: off` turns it off.
 */

afterEach(cleanupApps);

const ON: UiSettings = { ...TEST_UI_SETTINGS, security: { banner: 'on' } };
const OFF: UiSettings = { ...TEST_UI_SETTINGS, security: { banner: 'off' } };

describe('bannerOf', () => {
  it('says nothing with layer 3, without an answer, or with the mode off', () => {
    expect(bannerOf({ layer3: true, unenforced: 'refuse' }, 'on')).toBeUndefined();
    expect(bannerOf(undefined, 'on')).toBeUndefined();
    expect(bannerOf({ layer3: false, unenforced: 'refuse' }, 'off')).toBeUndefined();
  });

  it('refuse without layer 3 is the one that says the Director will not open; warn and allow are reduced', () => {
    expect(bannerOf({ layer3: false, unenforced: 'refuse' }, 'on')).toEqual({
      kind: 'refuse',
      value: 'refuse',
    });
    expect(bannerOf({ layer3: false, unenforced: 'warn' }, 'on')).toEqual({
      kind: 'reduced',
      value: 'warn',
    });
    expect(bannerOf({ layer3: false, unenforced: 'allow' }, 'on')?.kind).toBe('reduced');
  });
});

async function open(
  security: { layer3: boolean; unenforced: string } | 'error' | 'old',
  options: { settings?: UiSettings; locale?: string; rows?: number } = {},
) {
  const online = fakeOnline();
  seedStores(online.stores);
  const fake = online.client as unknown as {
    call: (route: { path: string }, ...rest: unknown[]) => unknown;
  };
  const original = fake.call.bind(online.client);
  fake.call = (route, ...rest) => {
    if (route.path !== '/v1/status') return original(route, ...rest);
    if (security === 'error') return Promise.reject(new Error('no service'));
    // An old daemon answers no `security`.
    return Promise.resolve({
      pid: 1,
      startedAt: 0,
      version: '0.0.0-test',
      dataDir: '/data',
      state: 'running',
      daemonId: '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b',
      apiVersion: API_VERSION,
      ...(security === 'old' ? {} : { security }),
    });
  };
  const locale = options.locale;
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: options.rows ?? 42 },
    settings: options.settings ?? ON,
    ...(locale === undefined ? {} : { systemLocale: locale }),
  });
  await app.waitForText(locale === undefined ? 'SCENARIOS' : 'CENÁRIOS');
  return app;
}

describe('the fixed row about the protection', () => {
  it('refuse without layer 3: says the Director will not open and how to fix it', async () => {
    const app = await open({ layer3: false, unenforced: 'refuse' });
    const frame = await app.waitForText('The Director will not open');
    expect(frame).toContain('security.unenforced=refuse');
    // The key of the assistant, with the tab where it works, and the key to edit.
    expect(frame).toMatch(/Fix: \S+ in Settings \(assistant\) or edit the key\./);
    expect(frame).toContain('⚠');
  });

  it('warn without layer 3: says the protection is reduced', async () => {
    const app = await open({ layer3: false, unenforced: 'warn' });
    const frame = await app.waitForText('Protection reduced');
    expect(frame).toContain('security.unenforced=warn');
    expect(frame).not.toContain('will not open');
  });

  it('allow without layer 3: says the protection is reduced', async () => {
    const app = await open({ layer3: false, unenforced: 'allow' });
    expect(await app.waitForText('Protection reduced')).toContain('security.unenforced=allow');
  });

  it('with layer 3: no row, whatever security.unenforced says', async () => {
    for (const unenforced of ['refuse', 'warn']) {
      const app = await open({ layer3: true, unenforced });
      const frame = await app.settle();
      expect(frame).not.toContain('Protection reduced');
      expect(frame).not.toContain('will not open');
      expect(frame).not.toContain('⚠');
    }
  });

  it('ui.security.banner: off hides the row, an old daemon or an error leaves the screen as it was', async () => {
    const cases = [
      [{ layer3: false, unenforced: 'refuse' }, OFF],
      ['old', ON],
      ['error', ON],
    ] as const;
    for (const [status, settings] of cases) {
      const app = await open(status, { settings });
      const frame = await app.settle();
      expect(frame).not.toContain('will not open');
      expect(frame).not.toContain('Protection reduced');
    }
  });

  it('speaks the language of the interface', async () => {
    const app = await open({ layer3: false, unenforced: 'refuse' }, { locale: 'pt_BR.UTF-8' });
    expect(await app.waitForText('O Diretor não abre')).toContain('em Configurações (assistente)');
  });

  it('takes one row of the body: the screen keeps its height', async () => {
    const tall = await open({ layer3: false, unenforced: 'warn' });
    await tall.waitForText('Protection reduced');
    const plain = await open({ layer3: true, unenforced: 'warn' });
    await plain.settle();
    expect(tall.frame().split('\n').length).toBe(plain.frame().split('\n').length);
  }, 20_000);
});
