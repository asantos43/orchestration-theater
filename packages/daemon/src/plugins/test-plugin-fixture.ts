// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the plugin processes only (excluded from the build of the package).
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest, type PluginManifest } from '@otheater/core';
import type { ActivePlugin, ActivePluginSource } from './aggregate.js';

/** The MCP server of the tests (`test-server-fixture.ts`), which Node runs as TypeScript. */
export const FIXTURE_SERVER_PATH = fileURLToPath(
  new URL('./test-server-fixture.ts', import.meta.url),
);

export interface FixturePluginOptions {
  readonly id?: string;
  /** Modes of the test server: `--extra`, `--missing`, `--crash-on-start`, `--no-exit`, `--events`. */
  readonly args?: readonly string[];
  /** Another manifest hash, to stand for a manifest that changed. */
  readonly hash?: string;
  /**
   * The event names the manifest declares (P8). Giving it also declares the tools `publish` and
   * `publish_events`, which the server has with `--events`.
   */
  readonly events?: readonly string[];
  /** The secrets the manifest declares (P7). */
  readonly secrets?: readonly string[];
}

/**
 * A valid manifest (it goes through the validator of P3) of a plugin whose server is the test
 * server over stdio. Tools: `echo` (author, reviewer), `env_report`, `slow` and `crash` (author),
 * `pid` (author, critic).
 */
export function fixtureManifest(options: FixturePluginOptions = {}): PluginManifest {
  const result = parsePluginManifest({
    manifest_version: 1,
    id: options.id ?? 'demo',
    version: '1.0.0',
    server: {
      type: 'stdio',
      command: [process.execPath, FIXTURE_SERVER_PATH, ...(options.args ?? [])],
    },
    tools: [
      { name: 'echo', roles: ['author', 'reviewer'], effects: 'read' },
      { name: 'env_report', roles: ['author'], effects: 'read', description: 'Reports the env.' },
      { name: 'slow', roles: ['author'], effects: 'read' },
      { name: 'crash', roles: ['author'], effects: 'local_write' },
      { name: 'pid', roles: ['author', 'critic'], effects: 'read' },
      ...(options.args?.includes('--leak') === true
        ? [
            { name: 'leak', roles: ['author'], effects: 'read' },
            { name: 'leak_error', roles: ['author'], effects: 'read' },
          ]
        : []),
      ...(options.events === undefined
        ? []
        : [
            { name: 'publish', roles: ['author'], effects: 'read' },
            { name: 'publish_events', roles: ['author'], effects: 'read' },
          ]),
    ],
    ...(options.events === undefined ? {} : { events: [...options.events] }),
    ...(options.secrets === undefined ? {} : { secrets: [...options.secrets] }),
  });
  if (!result.ok) {
    throw new Error(`the manifest of the fixture is invalid: ${JSON.stringify(result.problems)}`);
  }
  return result.manifest;
}

export function fixturePlugin(options: FixturePluginOptions = {}): ActivePlugin {
  const manifest = fixtureManifest(options);
  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    dir: dirname(FIXTURE_SERVER_PATH),
    manifestHash:
      options.hash ?? createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

/** A source with the plugins each project has, which a test changes with `set`. */
export class StaticPluginSource implements ActivePluginSource {
  readonly #byProject = new Map<string, readonly ActivePlugin[]>();
  readonly #listeners = new Set<() => void>();

  constructor(initial: Readonly<Record<string, readonly ActivePlugin[]>> = {}) {
    for (const [project, plugins] of Object.entries(initial)) this.#byProject.set(project, plugins);
  }

  activeFor(project: string): readonly ActivePlugin[] {
    return this.#byProject.get(project) ?? [];
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(project: string, plugins: readonly ActivePlugin[]): void {
    this.#byProject.set(project, plugins);
    for (const listener of this.#listeners) listener();
  }
}

/**
 * The manifest (as a plain object, to be parsed) of the plugin with a panel (P10): the server is
 * the test server with `--panel`. The panel has two tables (one with columns), a list, metrics, a
 * block that gets a value of the wrong shape, one whose source fails, and three actions: `clear`
 * (no approval), `purge` (the manifest asks for it) and `ship` (`external_write`, which the policy
 * asks for). `pt-BR` leaves `panel.stats` out, to show the fallback to `en`.
 */
export function panelManifestInput(id = 'panel-demo'): Record<string, unknown> {
  return {
    manifest_version: 1,
    id,
    version: '1.0.0',
    description: 'A plugin with a panel',
    server: { type: 'stdio', command: [process.execPath, FIXTURE_SERVER_PATH, '--panel'] },
    tools: [
      { name: 'rows', roles: [], effects: 'read' },
      { name: 'items', roles: [], effects: 'read' },
      { name: 'stats', roles: [], effects: 'read' },
      { name: 'wrong_shape', roles: [], effects: 'read' },
      { name: 'boom', roles: [], effects: 'read' },
      { name: 'counter', roles: [], effects: 'read' },
      { name: 'clear', roles: [], effects: 'local_write' },
      { name: 'purge', roles: [], effects: 'local_write', requires_producer_approval: true },
      { name: 'ship', roles: [], effects: 'external_write' },
    ],
    panel: [
      {
        type: 'table',
        title: 'panel.rows',
        source: 'rows',
        columns: [
          { key: 'name', label: 'panel.col.name' },
          { key: 'id', label: 'panel.col.id' },
        ],
      },
      { type: 'table', title: 'panel.all', source: 'rows' },
      { type: 'list', title: 'panel.items', source: 'items' },
      { type: 'metrics', title: 'panel.stats', source: 'stats' },
      { type: 'list', title: 'panel.wrong', source: 'wrong_shape' },
      { type: 'list', title: 'panel.broken', source: 'boom' },
      { type: 'action', label: 'panel.clear', tool: 'clear' },
      { type: 'action', label: 'panel.purge', tool: 'purge' },
      { type: 'action', label: 'panel.ship', tool: 'ship' },
    ],
    i18n: {
      en: {
        'panel.rows': 'Rows',
        'panel.all': 'All the rows',
        'panel.items': 'Items',
        'panel.stats': 'Numbers',
        'panel.wrong': 'Wrong shape',
        'panel.broken': 'Broken source',
        'panel.col.name': 'Name',
        'panel.col.id': 'Number',
        'panel.clear': 'Clear',
        'panel.purge': 'Purge',
        'panel.ship': 'Ship',
      },
      'pt-BR': {
        'panel.rows': 'Linhas',
        'panel.all': 'Todas as linhas',
        'panel.items': 'Itens',
        'panel.col.name': 'Nome',
        'panel.col.id': 'Número',
        'panel.clear': 'Limpar',
      },
    },
  };
}

/** The plugin of {@link panelManifestInput}, active in the project it is given to. */
export function panelPlugin(id = 'panel-demo'): ActivePlugin {
  const result = parsePluginManifest(panelManifestInput(id));
  if (!result.ok) {
    throw new Error(`the panel manifest is invalid: ${JSON.stringify(result.problems)}`);
  }
  return {
    id: result.manifest.id,
    version: result.manifest.version,
    manifest: result.manifest,
    dir: dirname(FIXTURE_SERVER_PATH),
    manifestHash: createHash('sha256').update(JSON.stringify(result.manifest)).digest('hex'),
  };
}
