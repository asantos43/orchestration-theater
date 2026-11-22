// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type {
  ApiEventEnvelope,
  ApiPanelBlock,
  ApiPlugin,
  ApiPluginDetail,
  ApiPluginPanel,
  PluginActionResult,
} from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../../layout.test-support.js';
import type { PluginsApi } from './api.js';
import { createPluginsTab } from './plugins-tab.js';

/**
 * The tab Plugins over a fake API (P11 of Phase 9): fake plugins, no daemon and no plugin code.
 * What the screen asks of the daemon is recorded, so a test says what was sent and in which order.
 */

afterEach(cleanupApps);

const F6 = '\x1b[17~';
const HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

function requestError(code: string, status: number, message: string): ApiRequestError {
  return new ApiRequestError({ status, body: { code, message } } as never, {
    routeId: 'plugins',
  });
}

const NO_DATA = { source: 'list_notes', error: null, truncated: null } as const;

const TABLE: ApiPanelBlock = {
  type: 'table',
  title: 'Notes',
  ...NO_DATA,
  columns: [
    { key: 'id', label: '#' },
    { key: 'text', label: 'Note' },
  ],
  rows: [
    { id: 1, text: 'buy milk' },
    { id: 2, text: 'call \u001b[31mthe bank\u001b[0m' },
  ],
};

const CLEAR: ApiPanelBlock = {
  type: 'action',
  label: 'Clear notes',
  tool: 'clear_notes',
  approval: 'manifest',
};

function listed(id: string, projects: ApiPlugin['projects'], extra: Partial<ApiPlugin> = {}) {
  return {
    id,
    version: '1.0.0',
    origin: `path:/plugins/${id}`,
    description: null,
    manifestHash: HASH,
    problem: null,
    projects,
    ...extra,
  };
}

function detailOf(plugin: ApiPlugin, secrets: string[], hash = HASH): ApiPluginDetail {
  return {
    ...plugin,
    currentManifestHash: hash,
    manifest: {} as never,
    summary: { secrets } as never,
    activation: [`Runs the program: node ${plugin.id}.js`, 'Writes nothing outside its folder.'],
  };
}

class FakePluginsApi implements PluginsApi {
  plugins: ApiPlugin[] = [];
  secrets: Record<string, string[]> = {};
  hash = HASH;
  blocks: Record<string, unknown[]> = {};
  panelError: Error | undefined;
  enableError: Error | undefined;
  actionResult: PluginActionResult | undefined;
  actionGate: Promise<void> | undefined;
  calls: string[] = [];
  enabled: { plugin: string; project: string; hash: string }[] = [];
  disabled: { plugin: string; project: string }[] = [];
  languages: (string | undefined)[] = [];

  list(): Promise<readonly ApiPlugin[]> {
    this.calls.push('list');
    return Promise.resolve(this.plugins);
  }
  detail(pluginId: string, language: string | undefined): Promise<ApiPluginDetail> {
    this.calls.push(`detail ${pluginId}`);
    this.languages.push(language);
    const found = this.plugins.find((p) => p.id === pluginId);
    if (found === undefined) return Promise.reject(requestError('not_found', 404, 'no plugin'));
    return Promise.resolve(detailOf(found, this.secrets[pluginId] ?? [], this.hash));
  }
  panel(pluginId: string, project: string): Promise<ApiPluginPanel> {
    this.calls.push(`panel ${pluginId} ${project}`);
    if (this.panelError !== undefined) return Promise.reject(this.panelError);
    return Promise.resolve({
      plugin: pluginId,
      project,
      language: 'en',
      blocks: this.blocks[pluginId] ?? [],
    } as unknown as ApiPluginPanel);
  }
  enable(pluginId: string, project: string, manifestHash: string) {
    if (this.enableError !== undefined) return Promise.reject(this.enableError);
    this.enabled.push({ plugin: pluginId, project, hash: manifestHash });
    this.plugins = this.plugins.map((p) =>
      p.id === pluginId
        ? {
            ...p,
            projects: [
              ...p.projects.filter((x) => x.project !== project),
              { project, state: 'active' as const },
            ],
          }
        : p,
    );
    return Promise.resolve({ changed: true } as never);
  }
  disable(pluginId: string, project: string) {
    this.disabled.push({ plugin: pluginId, project });
    this.plugins = this.plugins.map((p) =>
      p.id === pluginId ? { ...p, projects: p.projects.filter((x) => x.project !== project) } : p,
    );
    return Promise.resolve({ disabled: true } as never);
  }
  async action(pluginId: string, tool: string, project: string): Promise<PluginActionResult> {
    this.calls.push(`action ${pluginId} ${tool} ${project}`);
    if (this.actionGate !== undefined) await this.actionGate;
    return (
      this.actionResult ?? {
        plugin: pluginId,
        project,
        tool,
        ok: true,
        result: { cleared: 2 },
        truncated: null,
        error: null,
      }
    );
  }
}

let eventId = 0;
function emit(online: FakeOnline, type: string, payload: Record<string, unknown>): void {
  eventId += 1;
  const events = online.stores.events.getState().events;
  online.stores.events.setState({
    events: [
      ...events,
      { id: eventId + 5000, type, payload, timestamp: 1 } as unknown as ApiEventEnvelope,
    ],
  } as never);
}

interface Opened {
  readonly app: RenderedApp;
  readonly online: FakeOnline;
  /** The id of the project the side bar has selected. */
  readonly project: string;
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

/** Opens the app with the fake API; `build` gets the id of the project the side bar selected. */
async function open(
  api: FakePluginsApi,
  build: (project: string) => void,
  wait: string,
): Promise<Opened> {
  const online = fakeOnline();
  const { scenarios } = seedStores(online.stores);
  const project = scenarios[0]?.id ?? '';
  if (project === '') throw new Error('no scenario was seeded');
  build(project);
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 260, rows: 60 },
    tabContent: { plugins: createPluginsTab({ api }) },
  });
  await app.waitForText('SCENARIOS');
  app.press(F6);
  await app.waitForText(wait);
  return { app, online, project };
}

function standard(api: FakePluginsApi, project: string): void {
  api.plugins = [
    listed('notes', [{ project, state: 'active' }]),
    listed('weather', []),
    listed('stale', [{ project, state: 'needs_approval' }]),
    listed('wrecked', [], { problem: 'plugin.yaml is missing' }),
  ];
  api.secrets = { notes: ['NOTES_TOKEN'], weather: ['WEATHER_KEY'] };
  api.blocks = { notes: [TABLE, CLEAR] };
}

describe('the tab Plugins', () => {
  it('lists the plugins with their state in the project of the side bar, and draws the panel', async () => {
    const api = new FakePluginsApi();
    const { app, project } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'notes',
    );
    await app.waitForText('buy milk');
    const frame = app.frame();
    expect(frame).toContain('Installed');
    expect(frame).toMatch(/notes\s+1\.0\.0\s+on/);
    expect(frame).toMatch(/weather\s+1\.0\.0\s+off/);
    expect(frame).toMatch(/stale\s+1\.0\.0\s+needs a new approval/);
    expect(frame).toMatch(/wrecked\s+1\.0\.0\s+unusable/);
    // The table of the declared panel, the control chars of a plugin cleaned, and the action.
    expect(frame).toContain('call the bank');
    expect(frame).not.toContain('\u001b[31m');
    expect(frame).toContain('[ Clear notes ]');
    expect(frame).toContain('asks for your approval');
    expect(api.calls).toContain(`panel notes ${project}`);
    expect(api.languages.at(-1)).toBeDefined();
  });

  it('shows the secrets a plugin needs, the command that sets them, and never a value', async () => {
    const api = new FakePluginsApi();
    const { app, online, project } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'NOTES_TOKEN',
    );
    expect(app.frame()).toContain('ot plugin secret set notes NOTES_TOKEN --project ' + project);
    emit(online, 'plugin.secret_missing', {
      plugin: 'notes',
      project,
      secrets: ['NOTES_TOKEN'],
    });
    await waitUntil(() => app.frame().includes('missing'));
    expect(app.frame()).toMatch(/NOTES_TOKEN\s+missing/);
    // No field takes a secret: typing letters does not write anything.
    expect(api.enabled).toEqual([]);
  });

  it('turns a plugin on only after the card of what it asks for, with the hash that was shown', async () => {
    const api = new FakePluginsApi();
    const { app, project } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'weather',
    );
    await key(app, 'j');
    await waitUntil(() => app.frame().includes('WEATHER_KEY'));
    await key(app, 'e');
    await app.waitForText('Turn on weather 1.0.0');
    expect(app.frame()).toContain('Runs the program: node weather.js');
    expect(api.enabled).toEqual([]);
    // The file changes while the card is open: what goes back is what was shown.
    api.hash = NEW_HASH;
    await key(app, '\r');
    await waitUntil(() => api.enabled.length === 1);
    expect(api.enabled).toEqual([{ plugin: 'weather', project, hash: HASH }]);
    await app.waitForText('weather is on in');
    await waitUntil(() => /weather\s+1\.0\.0\s+on/.test(app.frame()));
  });

  it('cancels the card with Esc and sends nothing', async () => {
    const api = new FakePluginsApi();
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'weather',
    );
    await key(app, 'j');
    await key(app, 'e');
    await app.waitForText('Turn on weather');
    await key(app, '\x1b');
    await waitUntil(() => !app.frame().includes('Turn on weather'));
    expect(api.enabled).toEqual([]);
  });

  it('asks again when the manifest changed, and says why a turn on was refused', async () => {
    const api = new FakePluginsApi();
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'stale',
    );
    await key(app, 'j');
    await key(app, 'j');
    await key(app, 'e');
    await app.waitForText('changed. Approve it again');
    api.enableError = requestError('conflict', 409, 'the manifest changed on disk');
    await key(app, '\r');
    await app.waitForText('the manifest changed on disk');
    expect(api.enabled).toEqual([]);
  });

  it('refuses to turn on a plugin that cannot be used, or one that is already on', async () => {
    const api = new FakePluginsApi();
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'wrecked',
    );
    await key(app, 'e');
    await app.waitForText('is already on in this project');
    await key(app, 'j');
    await key(app, 'j');
    await key(app, 'j');
    await key(app, 'e');
    await app.waitForText('wrecked cannot be used');
    expect(api.enabled).toEqual([]);
  });

  it('turns a plugin off after the question, and any key but y cancels it', async () => {
    const api = new FakePluginsApi();
    const { app, project } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'buy milk',
    );
    await key(app, 'd');
    await app.waitForText('Turn notes off in');
    await key(app, 'n');
    await waitUntil(() => !app.frame().includes('Turn notes off in'));
    expect(api.disabled).toEqual([]);
    await key(app, 'd');
    await app.waitForText('Turn notes off in');
    await key(app, 'y');
    await waitUntil(() => api.disabled.length === 1);
    expect(api.disabled).toEqual([{ plugin: 'notes', project }]);
    await app.waitForText('notes is off in');
  });

  it('says there is nothing to turn off when the plugin is off', async () => {
    const api = new FakePluginsApi();
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'weather',
    );
    await key(app, 'j');
    await key(app, 'd');
    await app.waitForText('weather is not on in this project');
    expect(api.disabled).toEqual([]);
  });

  it('runs the action of the panel and says it waited for the approval of the Producer', async () => {
    const api = new FakePluginsApi();
    let release: () => void = () => undefined;
    api.actionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, project } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      '[ Clear notes ]',
    );
    await key(app, 'a');
    await app.waitForText('Clear notes: waiting for your approval');
    expect(api.calls).toContain(`action notes clear_notes ${project}`);
    release();
    await app.waitForText('Clear notes done');
    expect(app.frame()).toContain('cleared');
  });

  it('says why an action failed, by the code of the daemon', async () => {
    const api = new FakePluginsApi();
    api.actionResult = {
      plugin: 'notes',
      project: 'x',
      tool: 'clear_notes',
      ok: false,
      result: null,
      truncated: null,
      error: { code: 'tool_error', message: 'refused by the Producer' },
    } as unknown as PluginActionResult;
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      '[ Clear notes ]',
    );
    await key(app, 'a');
    await app.waitForText('Clear notes failed: tool error refused by the Producer');
  });

  it('picks the next action with N and runs the one picked', async () => {
    const api = new FakePluginsApi();
    const { app, project } = await open(
      api,
      (p) => {
        standard(api, p);
        api.blocks.notes = [
          TABLE,
          CLEAR,
          { type: 'action', label: 'Refresh', tool: 'refresh', approval: 'none' },
        ];
      },
      '[ Refresh ]',
    );
    await key(app, 'n');
    await key(app, 'a');
    await waitUntil(() => api.calls.includes(`action notes refresh ${project}`));
    expect(api.calls.some((call) => call.includes('clear_notes'))).toBe(false);
  });

  it('keeps drawing the panel when one block is unknown or has no data', async () => {
    const api = new FakePluginsApi();
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
        api.blocks.notes = [
          { type: 'gauge', title: 'From the future' },
          {
            type: 'list',
            title: 'Broken list',
            source: 'broken',
            items: [],
            error: { code: 'plugin_timeout', message: 'took too long' },
            truncated: null,
          },
          TABLE,
        ];
      },
      'buy milk',
    );
    const frame = app.frame();
    expect(frame).toContain('A block of the panel could not be read by this screen.');
    expect(frame).toContain('broken: no data (plugin timed out) took too long');
    expect(frame).toContain('buy milk');
  });

  it('says why the panel is not there when the daemon refuses it', async () => {
    const api = new FakePluginsApi();
    api.panelError = requestError('conflict', 409, 'the plugin is not active');
    const { app } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'Could not read the panel',
    );
    expect(app.frame()).toContain('the plugin is not active');
  });

  it('reads the list again on plugin.installed and the panel on an event of the plugin itself', async () => {
    const api = new FakePluginsApi();
    const { app, online } = await open(
      api,
      (p) => {
        standard(api, p);
      },
      'buy milk',
    );
    const lists = (): number => api.calls.filter((call) => call === 'list').length;
    const before = lists();
    api.plugins = [...api.plugins, listed('fresh', [])];
    emit(online, 'plugin.installed', { plugin: 'fresh' });
    await waitUntil(() => lists() > before);
    await waitUntil(() => app.frame().includes('fresh'));
    const panels = (): number => api.calls.filter((call) => call.startsWith('panel notes')).length;
    const seen = panels();
    emit(online, 'plugin.notes.changed', {});
    await waitUntil(() => panels() > seen);
    // An event of another plugin does not touch the panel of this one (let the reads in flight end).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = panels();
    emit(online, 'plugin.weather.changed', {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(panels()).toBe(again);
  });

  it('says so when no plugin is installed and when the list cannot be read', async () => {
    const empty = new FakePluginsApi();
    const first = await open(empty, () => undefined, 'No plugin installed');
    expect(first.app.frame()).toContain('ot plugin install');
    cleanupApps();

    const failing = new FakePluginsApi();
    failing.list = () => Promise.reject(requestError('internal', 500, 'daemon is busy'));
    const second = await open(failing, () => undefined, 'Could not read the plugins');
    expect(second.app.frame()).toContain('daemon is busy');
  });
});
