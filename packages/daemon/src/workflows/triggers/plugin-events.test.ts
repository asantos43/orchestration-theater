// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { checkPluginEvent, parsePluginEventType } from './plugin-events.js';
import { FakePlugins } from './triggers.test-support.js';

describe('parsePluginEventType', () => {
  it('splits plugin.<id>.<name>', () => {
    expect(parsePluginEventType('plugin.acme.finished')).toEqual({
      pluginId: 'acme',
      name: 'finished',
    });
    expect(parsePluginEventType('plugin.my-plugin.job.done')).toEqual({
      pluginId: 'my-plugin',
      name: 'job.done',
    });
  });

  it('does not take the daemon events nor other types', () => {
    expect(parsePluginEventType('plugin.installed')).toBeUndefined();
    expect(parsePluginEventType('workflow.run.finished')).toBeUndefined();
    expect(parsePluginEventType('plugins.acme.finished')).toBeUndefined();
  });
});

describe('checkPluginEvent (D6)', () => {
  const acme = { pluginId: 'acme', name: 'finished' };

  function deps(plugin_events: 'declared' | 'off', plugins: FakePlugins) {
    return { settings: () => ({ plugin_events }), plugins };
  }

  it('lets through an event the active plugin declares', () => {
    const plugins = new FakePlugins();
    plugins.activate('s1', 'acme', ['finished']);
    expect(checkPluginEvent(deps('declared', plugins), 's1', acme)).toEqual({ ok: true });
  });

  it('plugin_events off refuses first', () => {
    const plugins = new FakePlugins();
    plugins.activate('s1', 'acme', ['finished']);
    expect(checkPluginEvent(deps('off', plugins), 's1', acme)).toMatchObject({
      ok: false,
      reason: 'plugin_events_off',
    });
  });

  it('refuses a plugin that is not active in that scenario', () => {
    const plugins = new FakePlugins();
    plugins.activate('s2', 'acme', ['finished']);
    expect(checkPluginEvent(deps('declared', plugins), 's1', acme)).toMatchObject({
      ok: false,
      reason: 'plugin_inactive',
    });
  });

  it('refuses an event the manifest does not declare, or a manifest with no triggers', () => {
    const plugins = new FakePlugins();
    plugins.activate('s1', 'acme', ['other']);
    expect(checkPluginEvent(deps('declared', plugins), 's1', acme)).toMatchObject({
      ok: false,
      reason: 'undeclared',
    });
    const bare = new FakePlugins();
    bare.activate('s1', 'acme');
    expect(checkPluginEvent(deps('declared', bare), 's1', acme)).toMatchObject({
      ok: false,
      reason: 'undeclared',
    });
  });
});
