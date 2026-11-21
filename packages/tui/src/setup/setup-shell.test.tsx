// SPDX-License-Identifier: MPL-2.0
import type { ApiConfig, ApiRoles } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, seedStores } from '../layout.test-support.js';
import type { TabContentMap } from '../layout/tab-content.js';
import type { UiSettings } from '../settings.js';
import type { SettingsApi } from '../tabs/settings/api.js';
import { createSettingsTab } from '../tabs/settings/settings-tab.js';
import { FakeSetupApi, profileOf, requestError } from './fake-api.test-support.js';

/**
 * The assistant inside the TUI (P17 of Phase 7): the first run opens straight in it, and the
 * Settings tab opens it on the flow of the key. Fake daemon, fake accounts, no login.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 50 };
const ESC = '\x1b';
const F6 = '\x1b[15~';

function settingsWith(open: 'auto' | 'never', readTimeoutMs = 5000): UiSettings {
  return { ...TEST_UI_SETTINGS, setup: { open, readTimeoutMs } };
}

async function mount(
  setupApi: FakeSetupApi,
  settings: UiSettings,
  tabContent?: TabContentMap,
): Promise<RenderedApp> {
  const online = fakeOnline();
  seedStores(online.stores);
  return renderApp({ connector: online.connector, size: SIZE, settings, setupApi, tabContent });
}

const settingsApi: SettingsApi = {
  profiles: () => Promise.resolve([]),
  executors: () => Promise.resolve([]),
  roles: () =>
    Promise.resolve({
      preset: 'balanced',
      capabilityCheck: 'warn',
      allowedProfiles: [],
      roles: [],
      notes: [],
    } as unknown as ApiRoles),
  config: () => Promise.resolve({ config: {}, redactedPaths: [] } as unknown as ApiConfig),
  scenarioOverride: () => Promise.resolve({}),
  addProfile: () => Promise.reject(new Error('not used')),
  removeProfile: () => Promise.reject(new Error('not used')),
  putConfig: () => Promise.reject(new Error('not used')),
  startLogin: () => Promise.reject(new Error('not used')),
  submitLoginCode: () => Promise.resolve(),
  cancelLogin: () => Promise.resolve(),
};

const PROFILES = [profileOf('claude-code/main'), profileOf('codex/work')];

describe('the first run', () => {
  it('opens straight in the assistant when the daemon says there is no configuration', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, firstRunNeeded: true });
    const app = await mount(api, settingsWith('auto'));
    const frame = await app.waitForText('Setup assistant: first run');
    expect(frame).toContain('Pick the accounts that take part');
    // The assistant takes the screen: the layout is gone while it is open.
    expect(frame).not.toContain('SCENARIOS');
    expect(api.calls).toEqual(['overview', 'overview', 'start:first_run']);
  });

  it('leaving the assistant brings the layout back, and the run stays for the next time', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    const app = await mount(api, settingsWith('auto'));
    await app.waitForText('Pick the accounts that take part');
    app.press(ESC);
    await app.waitForText('SCENARIOS');
    expect(app.frame()).not.toContain('Setup assistant');
    expect(api.active.has('first_run')).toBe(true);
    // The gate is asked once per TUI: the layout does not fall back into the assistant.
    await app.settle();
    expect(app.frame()).not.toContain('Setup assistant');
  });

  it('does not open when the daemon already has a configuration', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, firstRunNeeded: false });
    const app = await mount(api, settingsWith('auto'));
    await app.waitForText('SCENARIOS');
    await app.settle();
    expect(app.frame()).not.toContain('Setup assistant');
    expect(api.calls).toEqual(['overview']);
  });

  it('does not even ask when ui.setup.open is never', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    const app = await mount(api, settingsWith('never'));
    await app.waitForText('SCENARIOS');
    await app.settle();
    expect(app.frame()).not.toContain('Setup assistant');
    expect(api.calls).toEqual([]);
  });

  it('says why when the daemon cannot be asked, and the layout stays usable', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    api.failNext = requestError('unavailable', 503, 'The daemon is starting.');
    const app = await mount(api, settingsWith('auto'));
    const frame = await app.waitForText('Could not check whether the first run is needed');
    expect(frame).toContain('The daemon is starting.');
    expect(frame).toContain('SCENARIOS');
  });

  it('gives up on a daemon that does not answer within ui.setup.readTimeoutMs', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES });
    api.hang = true;
    const app = await mount(api, settingsWith('auto', 100));
    const frame = await app.waitForText('Could not check whether the first run is needed');
    expect(frame).toContain('no answer in 100 ms');
    expect(frame).toContain('SCENARIOS');
  });
});

describe('the entries of the Settings tab', () => {
  async function inSettings(api: FakeSetupApi): Promise<RenderedApp> {
    const app = await mount(api, settingsWith('never'), {
      settings: createSettingsTab({ api: settingsApi, now: () => 1_000_000 }),
    });
    await app.waitForText('SCENARIOS');
    app.press(F6);
    await app.waitForText('Settings');
    await app.settle();
    return app;
  }

  it('W opens the add-account flow and leaving brings the tab back', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, firstRunNeeded: false });
    const app = await inSettings(api);
    app.press('w');
    const frame = await app.waitForText('Setup assistant: add an account');
    expect(frame).toContain('Pick the account to bring into the roles.');
    expect(api.calls).toContain('start:add_account');
    app.press(ESC);
    await app.waitForText('SCENARIOS');
    expect(app.frame()).not.toContain('Setup assistant');
  });

  it('P opens the change-preset flow', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, firstRunNeeded: false, current: 'quality' });
    const app = await inSettings(api);
    app.press('p');
    const frame = await app.waitForText('Setup assistant: change the preset');
    expect(frame).toMatch(/›quality/);
    expect(api.calls).toContain('start:change_preset');
  });

  it('Shift+W opens the first-run flow, and resumes it when it was left midway', async () => {
    const api = new FakeSetupApi({ profiles: PROFILES, firstRunNeeded: false });
    const app = await inSettings(api);
    app.press('W');
    await app.waitForText('Setup assistant: first run');
    app.press('\r');
    await app.waitForText('Pick the preset of the roles.');
    app.press(ESC);
    await app.waitForText('Pick the accounts that take part');
    app.press(ESC);
    await app.waitForText('SCENARIOS');
    app.press('W');
    const resumed = await app.waitForText('Setup assistant: first run');
    expect(resumed).toContain('Pick the accounts that take part');
    expect(api.calls.filter((call) => call === 'start:first_run')).toHaveLength(1);
  });
});
