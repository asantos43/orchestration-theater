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
  /** Modes of the test server: `--extra`, `--missing`, `--crash-on-start`, `--no-exit`. */
  readonly args?: readonly string[];
  /** Another manifest hash, to stand for a manifest that changed. */
  readonly hash?: string;
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
    ],
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
