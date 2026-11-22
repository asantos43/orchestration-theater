// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { Conflict, InvalidInput, NotFound, type PluginManifest } from '@otheater/core';
import type { Logger } from '../logger.js';
import type { Env } from '../paths.js';
import type { PluginInstallSource } from './install-sources.js';
import { readPluginManifest } from './manifest-file.js';
import {
  pluginPaths,
  type PluginOrigin,
  type PluginRegistry,
  type RegisterOutcome,
  type RegisteredPlugin,
} from './registry.js';
import {
  checkFolder,
  execRunner,
  fetchGit,
  fetchNpm,
  parseOrigin,
  resolveNpmCommand,
  type CommandRunner,
  type Fetched,
} from './sources.js';

/**
 * Installs, updates and removes plugins (N236, Phase 9, P4). It fetches from the origin into a
 * staging folder, checks the manifest with the P3 validator, puts the folder in its place and tells
 * the {@link PluginRegistry}. It never turns a plugin on: that is `enable`, which the Producer
 * approves after seeing what the plugin asks for.
 *
 * - `path`: the folder stays where it is (nothing is copied); the registry keeps its path and the
 *   hash of the manifest.
 * - `npm:<package>@<version>`: installed with `--ignore-scripts` and kept in
 *   `<data>/plugins/<id>/<version>/`; the registry keeps the version and the package hash.
 * - `git:<url>#<ref>`: cloned with no hooks, pinned to the commit the `ref` had, and kept in
 *   `<data>/plugins/<id>/<version>/` with no `.git`; the registry keeps the commit.
 *
 * `<version>` in the folder name is the one of the manifest. For npm it must be the version of the
 * package, so the folder name and the registry say the same thing.
 */

export interface PluginInstallerOptions {
  readonly registry: PluginRegistry;
  readonly dataDir: string;
  /** `plugins.install.sources`: the origins this installer accepts. */
  readonly sources: readonly PluginInstallSource[];
  /** `plugins.install.timeout`, in milliseconds: the limit of each `npm` or `git` run. */
  readonly timeoutMs: number;
  /** `plugins.install.npm`: `auto` (default) or the path of npm (see {@link resolveNpmCommand}). */
  readonly npm?: string | undefined;
  /** The environment `npm` and `git` start from (filtered by {@link childEnv}). */
  readonly env: Env;
  /** What a relative folder is relative to. */
  readonly cwd: string;
  /** Runs `npm` and `git` (default: `execFile`). Tests give a recorder or the real one. */
  readonly runner?: CommandRunner | undefined;
  readonly logger?: Logger | undefined;
  /** The tool names of the frozen registry, for the validator of the manifest. */
  readonly frameworkToolNames?: Iterable<string> | undefined;
}

export interface InstallResult {
  readonly id: string;
  readonly version: string;
  readonly origin: PluginOrigin;
  readonly dir: string;
  readonly manifest: PluginManifest;
  readonly manifestHash: string;
  readonly outcome: RegisterOutcome;
}

export interface RemoveResult {
  readonly record: RegisteredPlugin;
  /** True when the folder of the plugin was deleted (npm and git); a local folder is never touched. */
  readonly folderDeleted: boolean;
}

export class PluginInstaller {
  readonly #options: PluginInstallerOptions;
  readonly #paths: ReturnType<typeof pluginPaths>;

  constructor(options: PluginInstallerOptions) {
    this.#options = options;
    this.#paths = pluginPaths(options.dataDir);
  }

  /** `ot plugin install <origin>`: a new plugin. An id that is installed is refused: use `update`. */
  async install(originText: string): Promise<InstallResult> {
    return await this.#fetchAndRegister(originText, undefined);
  }

  /**
   * `ot plugin update <id> [<origin>]`: a reinstall (N236). With no origin, the one the plugin was
   * installed from (a git `ref` is read again, so a branch brings its new commit; a local folder is
   * read again; an npm version is the same one). With an origin, the plugin comes from there from
   * now on, but its id must be the same. If the manifest changed, the projects that had the plugin
   * on stay off until it is enabled again (`needsApproval` in the result).
   */
  async update(id: string, originText?: string): Promise<InstallResult> {
    const record = this.#options.registry.get(id);
    if (record === undefined) throw new NotFound(`No plugin "${id}" is installed`);
    return await this.#fetchAndRegister(originText ?? originTextOf(record.origin), id);
  }

  /** `ot plugin remove <id>`: forgets the plugin and deletes the folder it owns (never a local one). */
  async remove(id: string): Promise<RemoveResult> {
    const record = await this.#options.registry.remove(id);
    const folderDeleted = await this.#deleteManaged(record);
    return { record, folderDeleted };
  }

  // ---------------------------------------------------------------------------------------------

  async #fetchAndRegister(
    originText: string,
    updating: string | undefined,
  ): Promise<InstallResult> {
    const spec = parseOrigin(originText, this.#options.cwd);
    if (!this.#options.sources.includes(spec.source)) {
      throw new InvalidInput(
        `Installing from "${spec.source}" is off: plugins.install.sources is [${this.#options.sources.join(', ')}]`,
      );
    }
    const stage = join(this.#paths.staging, randomBytes(8).toString('hex'));
    try {
      let fetched: Fetched | undefined;
      let origin: PluginOrigin;
      let dir: string;
      if (spec.source === 'path') {
        await checkFolder(spec.path);
        dir = await realpath(spec.path);
        origin = { kind: 'path', path: dir };
      } else {
        await mkdir(stage, { recursive: true });
        const context = {
          runner: this.#options.runner ?? execRunner,
          env: this.#options.env,
          timeoutMs: this.#options.timeoutMs,
          stage,
          // Only npm needs the lookup: a `git` install does not fail for a missing npm.
          npm:
            spec.source === 'npm'
              ? resolveNpmCommand({ configured: this.#options.npm })
              : undefined,
        };
        fetched =
          spec.source === 'npm' ? await fetchNpm(spec, context) : await fetchGit(spec, context);
        origin = fetched.origin;
        dir = join(fetched.root, fetched.relativeDir);
      }

      const { manifest, hash } = await readPluginManifest(dir, {
        frameworkToolNames: this.#options.frameworkToolNames,
      });
      if (updating !== undefined && manifest.id !== updating) {
        throw new InvalidInput(
          `The plugin in ${originText} has id "${manifest.id}", not "${updating}": install it as a new plugin`,
        );
      }
      if (updating === undefined && this.#options.registry.get(manifest.id) !== undefined) {
        throw new Conflict(
          `The plugin "${manifest.id}" is already installed: use "ot plugin update ${manifest.id}"`,
        );
      }
      if (origin.kind === 'npm' && manifest.version !== origin.version) {
        throw new InvalidInput(
          `The package ${origin.name}@${origin.version} has a plugin.yaml with version ${manifest.version}: they must be the same`,
        );
      }

      const previous = this.#options.registry.get(manifest.id);
      if (fetched === undefined) {
        const outcome = await this.#options.registry.register({
          id: manifest.id,
          version: manifest.version,
          origin,
          dir,
          manifestHash: hash,
        });
        await this.#dropReplaced(previous, dir);
        return this.#result(manifest, hash, origin, dir, outcome);
      }

      // Put the folder in its place. An older one of the same version is moved aside first, and
      // comes back if the registry cannot be written.
      const finalRoot = join(this.#paths.dir, manifest.id, manifest.version);
      const finalDir = join(finalRoot, fetched.relativeDir);
      const aside = join(stage, 'replaced');
      await mkdir(dirname(finalRoot), { recursive: true });
      const hadOlder = await exists(finalRoot);
      if (hadOlder) await rename(finalRoot, aside);
      try {
        await rename(fetched.root, finalRoot);
        const outcome = await this.#options.registry.register({
          id: manifest.id,
          version: manifest.version,
          origin,
          dir: finalDir,
          manifestHash: hash,
        });
        await this.#dropReplaced(previous, finalDir);
        return this.#result(manifest, hash, origin, finalDir, outcome);
      } catch (error) {
        await rm(finalRoot, { recursive: true, force: true });
        if (hadOlder) await rename(aside, finalRoot);
        throw error;
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  #result(
    manifest: PluginManifest,
    manifestHash: string,
    origin: PluginOrigin,
    dir: string,
    outcome: RegisterOutcome,
  ): InstallResult {
    this.#options.logger?.info(
      { id: manifest.id, version: manifest.version, origin: origin.kind },
      outcome.kind === 'installed' ? 'plugin installed' : 'plugin updated',
    );
    return {
      id: manifest.id,
      version: manifest.version,
      origin,
      dir,
      manifest,
      manifestHash,
      outcome,
    };
  }

  /** After an update: the folder of the old version goes, unless it is the one now in use. */
  async #dropReplaced(
    previous: { readonly dir: string } | undefined,
    current: string,
  ): Promise<void> {
    if (previous === undefined || previous.dir === current) return;
    await this.#deleteFolderOf(previous.dir);
  }

  async #deleteManaged(record: RegisteredPlugin): Promise<boolean> {
    if (record.origin.kind === 'path') return false;
    return await this.#deleteFolderOf(record.dir);
  }

  /**
   * Deletes `<data>/plugins/<id>/<version>` given the folder of the plugin inside it. Only inside
   * `<data>/plugins`: a path from outside (a hand-edited `plugins.json`) is never deleted.
   */
  async #deleteFolderOf(dir: string): Promise<boolean> {
    const rel = relative(this.#paths.dir, dir);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const [id, version] = rel.split(/[\\/]/);
    if (id === undefined || version === undefined || id.startsWith('.')) return false;
    await rm(join(this.#paths.dir, id, version), { recursive: true, force: true });
    return true;
  }
}

/** The origin as the Producer would write it again (what `update` with no argument reinstalls). */
export function originTextOf(origin: PluginOrigin): string {
  switch (origin.kind) {
    case 'path':
      return `path:${origin.path}`;
    case 'npm':
      return `npm:${origin.name}@${origin.version}`;
    case 'git':
      return `git:${origin.url}#${origin.ref}`;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
