// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Conflict,
  NotFound,
  parsePluginManifest,
  type JsonValue,
  type PluginManifest,
} from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiFailure } from '../api/handlers.js';
import type { AskApproval } from '../browser/approval.js';
import { createTranslator } from '../i18n.js';
import { captureLogger, RecordingSituations } from '../test-helpers.js';
import { PluginAggregator, type ActivePlugin } from './aggregate.js';
import { catalogOf, PluginPanelService } from './panel.js';
import { DEFAULT_PLUGIN_PERMISSIONS, type PluginPermissionSettings } from './permissions.js';
import { PluginProcessPool } from './process-pool.js';
import {
  DEFAULT_PLUGIN_RUNTIME,
  type PluginNotice,
  type PluginRuntimeConfig,
} from './runtime-config.js';
import { panelManifestInput, panelPlugin, StaticPluginSource } from './test-plugin-fixture.js';

const stops: (() => Promise<void>)[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const translators = {
  en: await createTranslator('en'),
  'pt-BR': await createTranslator('pt-BR'),
};

interface Asked {
  readonly project: string;
  readonly question: string;
}

function setup(
  options: {
    runtime?: Partial<PluginRuntimeConfig>;
    permissions?: Partial<PluginPermissionSettings>;
    /** What the Producer answers; `cancel`: the question ends with no answer; `noChannel`: nobody to ask. */
    answer?: JsonValue;
    cancel?: true;
    noChannel?: true;
    plugin?: ActivePlugin;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'ot-panel-'));
  homes.push(home);
  const clock = new FakeClock();
  const { logger, lines } = captureLogger();
  const plugin = options.plugin ?? panelPlugin();
  const source = new StaticPluginSource({ p1: [plugin] });
  const notices: PluginNotice[] = [];
  const runtime = { ...DEFAULT_PLUGIN_RUNTIME, startTimeoutMs: 20_000, ...options.runtime };
  const pool = new PluginProcessPool({
    clock,
    logger,
    runtime: () => runtime,
    homeRoot: home,
    onNotice: (notice) => notices.push(notice),
  });
  const aggregator = new PluginAggregator({
    source,
    pool,
    logger,
    reservedNames: () => [],
    onNotice: (notice) => notices.push(notice),
  });
  stops.push(() => aggregator.stop());
  const situations = new RecordingSituations();
  const asked: Asked[] = [];
  const hooks = { onAsk: (): void => undefined };
  const answer = options.answer ?? 'Allow';
  const askApproval: AskApproval | undefined =
    options.noChannel === true
      ? undefined
      : (project, input) => {
          asked.push({ project, question: input.questions[0]?.question ?? '' });
          hooks.onAsk();
          return Promise.resolve({
            decisionId: 'd1',
            answer:
              options.cancel === true
                ? Promise.reject(new Error('ended with no answer'))
                : Promise.resolve(answer),
          });
        };
  const registry = {
    list: () => [],
    get: (id: string) =>
      id === plugin.id
        ? {
            id,
            version: plugin.version,
            origin: { type: 'local' as const, path: plugin.dir },
            dir: plugin.dir,
            installedAt: 0,
            manifestHash: plugin.manifestHash,
            currentManifestHash: plugin.manifestHash,
            manifest: plugin.manifest,
            problem: undefined,
            projects:
              source.activeFor('p1').length === 0
                ? []
                : [{ project: 'p1', state: 'active' as const }],
          }
        : undefined,
    readCurrent: () => Promise.reject(new Error('not used here')),
    enable: () => Promise.reject(new Error('not used here')),
    disable: () => Promise.reject(new Error('not used here')),
    activeFor: (project: string) => source.activeFor(project),
    refresh: () => Promise.resolve(),
  };
  const service = new PluginPanelService({
    registry: registry as never,
    aggregator,
    permissions: () => ({ ...DEFAULT_PLUGIN_PERMISSIONS, ...options.permissions }),
    runtime: () => runtime,
    askApproval,
    situations,
    onNotice: (notice) => notices.push(notice),
    logger,
    translator: (language) => (language.startsWith('pt') ? translators['pt-BR'] : translators.en),
    language: () => 'en',
  });
  /** How many times `clear`, `purge` and `ship` ran, read from the plugin itself. */
  const changes = async (): Promise<number> => {
    const reply = await aggregator.callTool(plugin, 'p1', 'counter', undefined);
    const first = reply.content[0];
    return Number(first?.type === 'text' ? first.text : Number.NaN);
  };
  return { service, aggregator, source, situations, asked, notices, lines, changes, plugin, hooks };
}

function block(panel: Awaited<ReturnType<PluginPanelService['panel']>>, index: number) {
  const found = panel.blocks[index];
  if (found === undefined) throw new Error(`no block ${String(index)}`);
  return found;
}

describe('PluginPanelService.panel', () => {
  it('fills the table, the list and the metrics from the tools the manifest names', async () => {
    const { service } = setup();
    const panel = await service.panel('panel-demo', 'p1', undefined);
    expect(panel).toMatchObject({ plugin: 'panel-demo', project: 'p1', language: 'en' });
    expect(panel.blocks).toHaveLength(9);

    const table = block(panel, 0);
    expect(table).toMatchObject({
      type: 'table',
      title: 'Rows',
      source: 'rows',
      error: null,
      truncated: null,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'id', label: 'Number' },
      ],
    });
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(5);
    expect(table.rows[0]).toMatchObject({ id: 1, name: 'row-1' });

    // No columns in the manifest: the keys of the rows, label = key.
    const derived = block(panel, 1);
    if (derived.type !== 'table') throw new Error('not a table');
    expect(derived.columns.map((column) => column.key)).toEqual(['id', 'name', 'note']);
    expect(derived.columns.map((column) => column.label)).toEqual(['id', 'name', 'note']);

    expect(block(panel, 2)).toMatchObject({ type: 'list', title: 'Items', items: ['a', 'b', 'c'] });
    expect(block(panel, 3)).toMatchObject({
      type: 'metrics',
      title: 'Numbers',
      metrics: [
        { key: 'open', value: 2 },
        { key: 'done', value: 5 },
      ],
    });
  });

  it('action blocks come with the approval the call will ask for, and no data', async () => {
    const { service } = setup();
    const panel = await service.panel('panel-demo', 'p1', undefined);
    expect(block(panel, 6)).toEqual({
      type: 'action',
      label: 'Clear',
      tool: 'clear',
      approval: 'none',
    });
    expect(block(panel, 7)).toMatchObject({ tool: 'purge', approval: 'manifest' });
    expect(block(panel, 8)).toMatchObject({ tool: 'ship', approval: 'policy' });
    const lenient = setup({ permissions: { externalWriteApproval: 'manifest' } });
    const again = await lenient.service.panel('panel-demo', 'p1', undefined);
    expect(block(again, 8)).toMatchObject({ tool: 'ship', approval: 'none' });
  });

  it('writes the screen text in the language asked, with en as the fallback per key', async () => {
    const { service } = setup();
    const panel = await service.panel('panel-demo', 'p1', 'pt-BR');
    expect(panel.language).toBe('pt-BR');
    expect(block(panel, 0)).toMatchObject({
      title: 'Linhas',
      columns: [
        { key: 'name', label: 'Nome' },
        { key: 'id', label: 'Número' },
      ],
    });
    // `panel.stats` is not in the pt-BR catalog: the English text, not the key.
    expect(block(panel, 3)).toMatchObject({ title: 'Numbers' });
    expect(block(panel, 6)).toMatchObject({ label: 'Limpar' });
    // `panel.ship` neither.
    expect(block(panel, 8)).toMatchObject({ label: 'Ship' });
  });

  it('a language the plugin has no catalog for gets en', async () => {
    const { service } = setup();
    const panel = await service.panel('panel-demo', 'p1', 'fr');
    expect(panel.language).toBe('en');
    expect(block(panel, 0)).toMatchObject({ title: 'Rows' });
  });

  it('a block whose source fails says why with a fixed text, never the text of the plugin', async () => {
    const { service, lines } = setup();
    const panel = await service.panel('panel-demo', 'p1', undefined);
    const broken = block(panel, 5);
    expect(broken).toMatchObject({
      type: 'list',
      title: 'Broken source',
      items: [],
      truncated: null,
      error: { code: 'tool_error' },
    });
    expect(JSON.stringify(panel)).not.toContain('hunter2');
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    // The other blocks are drawn.
    expect(block(panel, 2)).toMatchObject({ error: null });
  });

  it('a result of the wrong shape is invalid_result for that block alone', async () => {
    const { service } = setup();
    const panel = await service.panel('panel-demo', 'p1', undefined);
    expect(block(panel, 4)).toMatchObject({
      type: 'list',
      items: [],
      error: { code: 'invalid_result' },
    });
    expect(block(panel, 0)).toMatchObject({ error: null });
  });

  it('refuses to call a source that does not have effects: read, even if the manifest got through', async () => {
    const input = panelManifestInput();
    // What the validator of P3 would refuse; here it is forged to prove the daemon checks again.
    const result = parsePluginManifest(input);
    if (!result.ok) throw new Error('the base manifest must be valid');
    const forged: PluginManifest = {
      ...result.manifest,
      panel: [{ type: 'list', title: 'panel.items', source: 'clear' }],
    };
    const { service, changes, plugin } = setup({ plugin: { ...panelPlugin(), manifest: forged } });
    const panel = await service.panel('panel-demo', 'p1', undefined);
    expect(block(panel, 0)).toMatchObject({ error: { code: 'not_readable' }, items: [] });
    expect(plugin.id).toBe('panel-demo');
    expect(await changes()).toBe(0);
  });

  it('a plugin that is not on in the project is a conflict; an unknown plugin is not found', async () => {
    const { service, source, plugin } = setup();
    source.set('p1', []);
    await expect(service.panel('panel-demo', 'p1', undefined)).rejects.toBeInstanceOf(Conflict);
    await expect(service.panel('nobody', 'p1', undefined)).rejects.toBeInstanceOf(NotFound);
    source.set('p1', [plugin]);
    await expect(service.panel('panel-demo', 'p1', undefined)).resolves.toBeDefined();
  });
});

describe('PluginPanelService.panel, the limits', () => {
  it('cuts to plugins.panel.max_rows with a warning and a notice, and does not break', async () => {
    const { service, notices, lines } = setup({ runtime: { panelMaxRows: 2 } });
    const panel = await service.panel('panel-demo', 'p1', undefined);
    const table = block(panel, 0);
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(2);
    expect(table.truncated).toEqual({ reason: 'rows', total: 5, kept: 2, limit: 2 });
    expect(table.error).toBeNull();
    const cuts = notices.filter((notice) => notice.kind === 'panel_truncated');
    expect(cuts).toContainEqual({
      kind: 'panel_truncated',
      plugin: 'panel-demo',
      project: 'p1',
      source: 'rows',
      reason: 'rows',
      total: 5,
      kept: 2,
      limit: 2,
    });
    expect(
      lines.some((line) => line.level === 'warn' && line.msg.includes('cut to the limit')),
    ).toBe(true);
    // `items` has three entries: the list is cut too, and `stats` (two keys) is not.
    expect(block(panel, 2)).toMatchObject({ items: ['a', 'b'] });
    expect(block(panel, 3)).toMatchObject({ truncated: null });
  });

  it('cuts to plugins.panel.max_bytes, counting the JSON of what is kept', async () => {
    // A row is about 70 bytes of JSON; room for two of them and not three.
    const { service, notices } = setup({ runtime: { panelMaxBytes: 160 } });
    const panel = await service.panel('panel-demo', 'p1', undefined);
    const table = block(panel, 0);
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(2);
    expect(table.truncated).toMatchObject({ reason: 'bytes', limit: 160 });
    expect(table.truncated?.total).toBeGreaterThan(160);
    expect(table.truncated?.kept).toBeLessThanOrEqual(160);
    expect(
      notices.filter((notice) => notice.kind === 'panel_truncated' && notice.reason === 'bytes')
        .length,
    ).toBeGreaterThan(0);
  });

  it('max_bytes off leaves the bytes alone', async () => {
    const { service, notices } = setup({ runtime: { panelMaxBytes: null } });
    const panel = await service.panel('panel-demo', 'p1', undefined);
    const table = block(panel, 0);
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(5);
    expect(notices.filter((notice) => notice.kind === 'panel_truncated')).toEqual([]);
  });

  it('when both limits cut, the answer carries the second and the log has both', async () => {
    const { service, notices } = setup({ runtime: { panelMaxRows: 4, panelMaxBytes: 160 } });
    const panel = await service.panel('panel-demo', 'p1', undefined);
    const table = block(panel, 0);
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.truncated?.reason).toBe('bytes');
    const reasons = notices
      .filter((notice) => notice.kind === 'panel_truncated' && notice.source === 'rows')
      .map((notice) => (notice.kind === 'panel_truncated' ? notice.reason : ''));
    expect(reasons).toContain('rows');
    expect(reasons).toContain('bytes');
  });
});

describe('PluginPanelService.action', () => {
  it('an action with no approval runs at once, with no question and no permission event', async () => {
    const { service, asked, situations, changes } = setup();
    const result = await service.action('panel-demo', 'clear', 'p1');
    expect(result).toEqual({
      plugin: 'panel-demo',
      project: 'p1',
      tool: 'clear',
      ok: true,
      result: 'clear done',
      truncated: null,
      error: null,
    });
    expect(asked).toEqual([]);
    expect(situations.recorded).toEqual([]);
    expect(await changes()).toBe(1);
  });

  it('waits for the Producer; a yes runs the tool and the events say asked and answered', async () => {
    const { service, asked, situations, changes } = setup({ answer: 'Allow' });
    const result = await service.action('panel-demo', 'purge', 'p1');
    expect(result).toMatchObject({ ok: true, result: 'purge done' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.project).toBe('p1');
    expect(asked[0]?.question).toContain('panel-demo__purge');
    expect(await changes()).toBe(1);
    expect(situations.recorded.map((item) => item.type)).toEqual([
      'permission.asked',
      'permission.answered',
    ]);
    expect(situations.of('permission.answered')).toEqual([
      {
        sessionId: 'producer',
        tool: 'panel-demo__purge',
        paths: [],
        pathCount: 0,
        answer: 'allow',
        rule: 'plugin:panel-demo',
        reason: 'plugin_tool_approved',
      },
    ]);
    expect(situations.recorded[0]?.correlation).toEqual({ scenarioId: 'p1' });
  });

  it('the policy asks for an external_write too, and a yes runs it', async () => {
    const { service, asked } = setup();
    await expect(service.action('panel-demo', 'ship', 'p1')).resolves.toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('a no never reaches the plugin: 409, a rejection event and a tool_refused notice', async () => {
    const { service, situations, notices, changes } = setup({ answer: 'Deny' });
    const failure = await service
      .action('panel-demo', 'purge', 'p1')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({ code: 'conflict' });
    expect(await changes()).toBe(0);
    expect(situations.of('permission.answered')).toMatchObject([
      { answer: 'reject', reason: 'plugin_tool_refused', rule: 'plugin:panel-demo' },
    ]);
    expect(notices).toContainEqual({
      kind: 'tool_refused',
      plugin: 'panel-demo',
      project: 'p1',
      tool: 'purge',
      role: 'producer',
      reason: 'approval_denied',
    });
  });

  it('free text is a no, because only an exact yes lets it run', async () => {
    const { service, changes } = setup({ answer: 'ok, go ahead' });
    await expect(service.action('panel-demo', 'purge', 'p1')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await changes()).toBe(0);
  });

  it('a question that ends with no answer is a cancel: 409, and the tool does not run', async () => {
    const { service, notices, situations, changes } = setup({ cancel: true });
    await expect(service.action('panel-demo', 'purge', 'p1')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await changes()).toBe(0);
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'tool_refused', reason: 'approval_cancelled' }),
    );
    expect(situations.of('permission.answered')).toMatchObject([{ answer: 'reject' }]);
  });

  it('nobody to ask is 503 unavailable, never a yes', async () => {
    const { service, notices, changes } = setup({ noChannel: true });
    await expect(service.action('panel-demo', 'purge', 'p1')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await changes()).toBe(0);
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'tool_refused', reason: 'approval_unavailable' }),
    );
  });

  it('the deny modes of plugins.permissions bind the Producer: 403 and a notice', async () => {
    const { service, asked, notices, changes } = setup({ permissions: { localWrite: 'deny' } });
    await expect(service.action('panel-demo', 'clear', 'p1')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(asked).toEqual([]);
    expect(await changes()).toBe(0);
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'tool_refused', reason: 'not_allowed', role: 'producer' }),
    );
  });

  it('only a tool an action block names can be run: another tool of the manifest is not found', async () => {
    const { service, changes } = setup();
    await expect(service.action('panel-demo', 'counter', 'p1')).rejects.toBeInstanceOf(NotFound);
    await expect(service.action('panel-demo', 'not_a_tool', 'p1')).rejects.toBeInstanceOf(NotFound);
    expect(await changes()).toBe(0);
  });

  it('a plugin turned off while the Producer decided does not run', async () => {
    const { service, source, hooks, changes } = setup({ answer: 'Allow' });
    hooks.onAsk = () => {
      source.set('p1', []);
    };
    await expect(service.action('panel-demo', 'purge', 'p1')).rejects.toBeInstanceOf(Conflict);
    expect(await changes()).toBe(0);
  });

  it('the answer of an action over max_bytes is not sent: null, with the cut and a notice', async () => {
    const { service, notices } = setup({ runtime: { panelMaxBytes: 4 } });
    const result = await service.action('panel-demo', 'clear', 'p1');
    expect(result).toMatchObject({ ok: true, result: null });
    expect(result.truncated).toMatchObject({ reason: 'bytes', kept: 0, limit: 4 });
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'panel_truncated', source: 'clear', reason: 'bytes' }),
    );
  });
});

describe('catalogOf', () => {
  const manifest = (): PluginManifest => {
    const result = parsePluginManifest(panelManifestInput());
    if (!result.ok) throw new Error('invalid');
    return result.manifest;
  };

  it('prefers the exact tag, then the same primary language, then en', () => {
    expect(catalogOf(manifest(), 'pt-BR').language).toBe('pt-BR');
    expect(catalogOf(manifest(), 'pt-br').language).toBe('pt-BR');
    expect(catalogOf(manifest(), 'pt').language).toBe('pt-BR');
    expect(catalogOf(manifest(), 'en-GB').language).toBe('en');
    expect(catalogOf(manifest(), 'ja').language).toBe('en');
  });

  it('a key nobody has shows as the key', () => {
    expect(catalogOf(manifest(), 'pt-BR').text('panel.nothing')).toBe('panel.nothing');
  });
});

describe('the manifest validator (P3), seen from the panel', () => {
  it('refuses a block whose source does not have effects: read', () => {
    for (const effects of ['local_write', 'network', 'external_write']) {
      const input = panelManifestInput() as { tools: { name: string; effects: string }[] };
      const tool = input.tools.find((entry) => entry.name === 'rows');
      if (tool === undefined) throw new Error('no rows');
      tool.effects = effects;
      const result = parsePluginManifest(input);
      expect(result.ok, effects).toBe(false);
      if (!result.ok) {
        expect(result.problems.map((problem) => problem.path)).toContain('panel[0].source');
      }
    }
  });
});
