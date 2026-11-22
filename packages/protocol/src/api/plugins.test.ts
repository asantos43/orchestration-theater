// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ApiPanelBlockSchema,
  callPluginAction,
  disablePlugin,
  enablePlugin,
  EnablePluginBodySchema,
  getPlugin,
  getPluginPanel,
  listPlugins,
  PLUGIN_ROUTES,
  PluginActionParamsSchema,
  PluginActionResultSchema,
  PluginPanelQuerySchema,
  PluginParamsSchema,
} from './plugins.js';
import { API_ROUTES } from './registry.js';

describe('the /v1/plugins routes', () => {
  it('are in the registry, with the methods and the paths of the architecture', () => {
    expect(
      Object.values(PLUGIN_ROUTES).map((route) => [route.id, route.method, route.path]),
    ).toEqual([
      ['listPlugins', 'GET', '/v1/plugins'],
      ['getPlugin', 'GET', '/v1/plugins/:pluginId'],
      ['enablePlugin', 'POST', '/v1/plugins/:pluginId/enable'],
      ['disablePlugin', 'POST', '/v1/plugins/:pluginId/disable'],
      ['getPluginPanel', 'GET', '/v1/plugins/:pluginId/panel'],
      ['callPluginAction', 'POST', '/v1/plugins/:pluginId/actions/:tool'],
    ]);
    for (const route of [
      listPlugins,
      getPlugin,
      enablePlugin,
      disablePlugin,
      getPluginPanel,
      callPluginAction,
    ]) {
      expect(Object.values(API_ROUTES)).toContain(route);
    }
  });

  it('read the plugin id and the tool from the path, with the rules of the manifest', () => {
    expect(PluginParamsSchema.safeParse({ pluginId: 'postgres-db' }).success).toBe(true);
    expect(PluginParamsSchema.safeParse({ pluginId: 'Postgres DB' }).success).toBe(false);
    expect(PluginActionParamsSchema.safeParse({ pluginId: 'demo', tool: 'migrate' }).success).toBe(
      true,
    );
    expect(PluginActionParamsSchema.safeParse({ pluginId: 'demo', tool: '' }).success).toBe(false);
  });

  it('ask for the project of the panel, and take a language tag only', () => {
    expect(PluginPanelQuerySchema.safeParse({}).success).toBe(false);
    expect(PluginPanelQuerySchema.safeParse({ project: 'sc1', lang: 'pt-BR' }).success).toBe(true);
    expect(PluginPanelQuerySchema.safeParse({ project: 'sc1', lang: 'not a tag' }).success).toBe(
      false,
    );
    expect(PluginPanelQuerySchema.safeParse({ project: 'sc1', extra: 1 }).success).toBe(false);
  });

  it('enable takes an optional hash of 64 hex digits and nothing else', () => {
    expect(EnablePluginBodySchema.safeParse({ project: 'sc1' }).success).toBe(true);
    expect(
      EnablePluginBodySchema.safeParse({ project: 'sc1', manifestHash: 'a'.repeat(64) }).success,
    ).toBe(true);
    expect(EnablePluginBodySchema.safeParse({ project: 'sc1', manifestHash: 'xyz' }).success).toBe(
      false,
    );
    expect(EnablePluginBodySchema.safeParse({ project: 'sc1', yes: true }).success).toBe(false);
  });

  it('the blocks of the panel are told apart by their type', () => {
    const base = { title: 'Rows', source: 'rows', error: null, truncated: null };
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'table',
        ...base,
        columns: [{ key: 'a', label: 'A' }],
        rows: [{ a: 1 }],
      }).success,
    ).toBe(true);
    expect(ApiPanelBlockSchema.safeParse({ type: 'list', ...base, items: [1, 'a'] }).success).toBe(
      true,
    );
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'metrics',
        ...base,
        metrics: [{ key: 'open', value: 2 }],
      }).success,
    ).toBe(true);
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'action',
        label: 'Go',
        tool: 'go',
        approval: 'manifest',
      }).success,
    ).toBe(true);
    expect(ApiPanelBlockSchema.safeParse({ type: 'chart', ...base }).success).toBe(false);
    // A block with an error has a code of the list, and the text of the daemon.
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'list',
        ...base,
        items: [],
        error: { code: 'tool_error', message: 'x' },
      }).success,
    ).toBe(true);
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'list',
        ...base,
        items: [],
        error: { code: 'whatever', message: 'x' },
      }).success,
    ).toBe(false);
  });

  it('the cut of a block says the reason, what was there and what stayed', () => {
    const base = { title: 'Rows', source: 'rows', error: null };
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'list',
        ...base,
        items: [],
        truncated: { reason: 'rows', total: 5, kept: 2, limit: 2 },
      }).success,
    ).toBe(true);
    expect(
      ApiPanelBlockSchema.safeParse({
        type: 'list',
        ...base,
        items: [],
        truncated: { reason: 'size', total: 5, kept: 2, limit: 2 },
      }).success,
    ).toBe(false);
  });

  it('the result of an action is ok with a result, or not ok with an error', () => {
    const ok = {
      plugin: 'demo',
      project: 'sc1',
      tool: 'go',
      ok: true,
      result: { done: true },
      truncated: null,
      error: null,
    };
    expect(PluginActionResultSchema.safeParse(ok).success).toBe(true);
    expect(
      PluginActionResultSchema.safeParse({
        ...ok,
        ok: false,
        result: null,
        error: { code: 'plugin_timeout', message: 'x' },
      }).success,
    ).toBe(true);
  });
});
