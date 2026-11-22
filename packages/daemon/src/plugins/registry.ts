// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import {
  Conflict,
  InvalidInput,
  NotFound,
  PLUGIN_ID_PATTERN,
  type Clock,
  type PluginManifest,
} from '@otheater/core';
import { writePrivateFileAtomic } from '@otheater/client/node';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { readPluginManifest } from './manifest-file.js';

/**
 * The registry of the installed plugins and of their activation by project (N235, N236; Phase 9,
 * P4; architecture 5.14).
 *
 * What is kept, in `<data>/plugins.json` [proposta] (plain JSON, written atomically):
 * - which plugins are installed: id, version, where from (the {@link PluginOrigin}), the folder
 *   the server runs in and the hash of the manifest at install time;
 * - which projects have each plugin on, with the hash of the manifest the Producer approved when
 *   they turned it on. [proposta] The list of active plugins of a project lives here, and not in
 *   `config.yaml` (`projects.<p>.plugins`): the file is written by a command with the daemon
 *   running, and `config.yaml` is a file the owner edits by hand, read once at the start.
 *
 * The rule that keeps a changed manifest from running is one comparison: a plugin is ACTIVE in a
 * project only while the hash of the `plugin.yaml` that is on disk now equals the hash approved for
 * that project. An update that brings another manifest, or a local folder someone edited, makes the
 * hashes differ, so the plugin goes off for every project until `ot plugin enable` approves it
 * again. Nothing else decides it.
 *
 * The registry is read in memory ({@link PluginRegistry.activeFor} is synchronous, for the
 * aggregator of P5 to call in a hot path); the file and the manifests are read again by
 * {@link PluginRegistry.refresh} (the daemon calls it when the file changes, and a caller about to
 * start a plugin process should call it first: it is a few small files).
 *
 * No `plugin.*` event is written here (they are P8's). What a listener of P8 hooks into is
 * {@link PluginRegistry.onNotice}: one typed notice per fact (installed, updated, removed, enabled,
 * disabled, needs approval, broken), the same ones that are logged.
 */

/** The version of the file format of `plugins.json`. */
export const PLUGINS_FILE_VERSION = 1;

/** The file and the folders of the plugins inside the data directory. */
export function pluginPaths(dataDir: string): {
  readonly file: string;
  readonly lock: string;
  /** `<data>/plugins`: the folders of the plugins installed from npm and git. */
  readonly dir: string;
  /** Where a download is unpacked before it is checked and moved to its place. */
  readonly staging: string;
} {
  return {
    file: join(dataDir, 'plugins.json'),
    lock: join(dataDir, 'plugins.json.lock'),
    dir: join(dataDir, 'plugins'),
    staging: join(dataDir, 'plugins', '.staging'),
  };
}

// ---------------------------------------------------------------------------------------------
// The file

const idSchema = z.string().regex(PLUGIN_ID_PATTERN);
/** A project id is free text of the store; this only keeps the odd values out of the file. */
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const projectSchema = z
  .string()
  .regex(PROJECT_PATTERN)
  .refine((value) => value !== '__proto__');

const originSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('path'), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('npm'),
    name: z.string().min(1),
    version: z.string().min(1),
    /** The package hash: the `integrity` npm wrote in the lock file (`sha512-...`). */
    integrity: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().min(1),
    /** The commit the `ref` had at install time: the folder is that commit and nothing else. */
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
]);

/** Where a plugin came from (N236). */
export type PluginOrigin = z.infer<typeof originSchema>;

const activationSchema = z.strictObject({
  project: projectSchema,
  /** The hash of the `plugin.yaml` the Producer approved for this project. */
  approvedManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAt: z.int().nonnegative(),
});

const recordSchema = z.strictObject({
  id: idSchema,
  version: z.string().min(1),
  origin: originSchema,
  /** The folder with the `plugin.yaml` and the server: where the process of the plugin runs. */
  dir: z.string().min(1),
  /** The hash of the manifest when it was installed or last updated. */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  installedAt: z.int().nonnegative(),
  projects: z.array(activationSchema),
});

const fileSchema = z.strictObject({
  version: z.literal(PLUGINS_FILE_VERSION),
  plugins: z.array(recordSchema),
});

/** An installed plugin as the file keeps it. */
export type RegisteredPlugin = z.infer<typeof recordSchema>;
/** The activation of a plugin in one project, as the file keeps it. */
export type PluginActivation = z.infer<typeof activationSchema>;
type PluginsFile = z.infer<typeof fileSchema>;

// ---------------------------------------------------------------------------------------------
// What the others read

/**
 * A plugin that is active in a project, with the manifest validated by P3 and the folder its
 * server runs in. THE interface P5 (processes of the plugins) and the aggregator read; keep it
 * stable. It is frozen, and `manifestHash` is the hash of the manifest the Producer approved (which
 * is the one on disk: that is what makes the plugin active).
 */
export interface ActivePlugin {
  readonly id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  /** Absolute path of the folder of the plugin (for the `path` origin, the folder itself). */
  readonly dir: string;
  readonly manifestHash: string;
}

/** The state of a plugin in one project. */
export const PLUGIN_PROJECT_STATES = ['active', 'needs_approval', 'broken'] as const;
export type PluginProjectState = (typeof PLUGIN_PROJECT_STATES)[number];

/** An installed plugin as `ot plugin list` shows it. */
export interface PluginView {
  readonly id: string;
  readonly version: string;
  readonly origin: PluginOrigin;
  readonly dir: string;
  readonly installedAt: number;
  /** The hash registered at install or update time. */
  readonly manifestHash: string;
  /** The hash of the manifest on disk now; `undefined` when it cannot be read (see `problem`). */
  readonly currentManifestHash: string | undefined;
  readonly manifest: PluginManifest | undefined;
  /** Why the folder cannot be used (missing, invalid manifest, another id), when it cannot. */
  readonly problem: string | undefined;
  /** The projects that have it on, each active or waiting for a new approval. */
  readonly projects: readonly { readonly project: string; readonly state: PluginProjectState }[];
}

/** A fact about the registry, for the logger and for the plugins of P8 (it writes the events). */
export type PluginNotice =
  | {
      readonly kind: 'installed' | 'updated' | 'removed';
      readonly id: string;
      readonly version: string;
    }
  | { readonly kind: 'enabled' | 'disabled'; readonly id: string; readonly project: string }
  | {
      /** The manifest changed (update or edited folder): these projects are off until approved. */
      readonly kind: 'needs_approval';
      readonly id: string;
      readonly projects: readonly string[];
    }
  | { readonly kind: 'broken'; readonly id: string; readonly problem: string };

/** The change of the active plugins: which projects have another list now. */
export interface PluginsChange {
  readonly projects: readonly string[];
  readonly plugins: readonly string[];
}

export type PluginNoticeListener = (notice: PluginNotice) => void;
export type PluginsChangeListener = (change: PluginsChange) => void;

/** What {@link PluginRegistry.register} did. */
export interface RegisterOutcome {
  readonly kind: 'installed' | 'updated';
  readonly previous: RegisteredPlugin | undefined;
  /** The projects that had it on and must approve again (the manifest is another). */
  readonly needsApproval: readonly string[];
}

// ---------------------------------------------------------------------------------------------

interface Loaded {
  readonly record: RegisteredPlugin;
  readonly manifest: PluginManifest | undefined;
  readonly currentHash: string | undefined;
  readonly problem: string | undefined;
}

export interface PluginRegistryOptions {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger?: Logger | undefined;
  /** The tool names of the frozen registry; a plugin tool may not take one (P3). */
  readonly frameworkToolNames?: Iterable<string> | undefined;
  /** A lock older than this is left by a process that died, and is taken over [proposta: 60 s]. */
  readonly lockStaleMs?: number | undefined;
}

const LOCK_RETRY_MS = 50;
const LOCK_ATTEMPTS = 100;

export class PluginRegistry {
  readonly #paths: ReturnType<typeof pluginPaths>;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #frameworkToolNames: readonly string[] | undefined;
  readonly #lockStaleMs: number;
  readonly #noticeListeners = new Set<PluginNoticeListener>();
  readonly #changeListeners = new Set<PluginsChangeListener>();
  #loaded: ReadonlyMap<string, Loaded> = new Map();
  #active: ReadonlyMap<string, readonly ActivePlugin[]> = new Map();
  /** Serializes the mutations and the reloads of this process. */
  #queue: Promise<unknown> = Promise.resolve();
  #watcher: FSWatcher | undefined;
  #watchTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(options: PluginRegistryOptions) {
    this.#paths = pluginPaths(options.dataDir);
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#frameworkToolNames =
      options.frameworkToolNames === undefined ? undefined : [...options.frameworkToolNames];
    this.#lockStaleMs = options.lockStaleMs ?? 60_000;
  }

  /**
   * Reads the file and the manifests. A file that cannot be read or is not valid leaves the
   * registry EMPTY (no plugin on) and logs an error, without touching the file: the daemon starts
   * and the owner fixes the file. The commands (`install`, `enable`...) refuse on such a file.
   */
  static async open(options: PluginRegistryOptions): Promise<PluginRegistry> {
    const registry = new PluginRegistry(options);
    await registry.refresh();
    return registry;
  }

  // ----- reads -------------------------------------------------------------------------------

  /**
   * The plugins active in a project, in id order: those that are on for the project, whose
   * manifest on disk is the one approved. Synchronous and from memory; see {@link refresh}. The
   * array is frozen and never changes: a later change makes a new array.
   */
  activeFor(project: string): readonly ActivePlugin[] {
    return this.#active.get(project) ?? NO_PLUGINS;
  }

  /** The projects that have at least one active plugin. */
  activeProjects(): readonly string[] {
    return [...this.#active.keys()].sort();
  }

  /** The active plugins of every project, frozen, for the snapshot of the registries. */
  activeSnapshot(): ReadonlyMap<string, readonly ActivePlugin[]> {
    return this.#active;
  }

  /** Every installed plugin, in id order, with the state it has in each project. */
  list(): readonly PluginView[] {
    return [...this.#loaded.values()]
      .map((loaded) => viewOf(loaded))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginView | undefined {
    const loaded = this.#loaded.get(id);
    return loaded === undefined ? undefined : viewOf(loaded);
  }

  /**
   * The manifest of an installed plugin read from disk NOW (not from memory), with its hash: what
   * `enable` shows to the Producer and what it approves. Throws `NotFound` or `InvalidInput`.
   */
  async readCurrent(id: string): Promise<{
    readonly record: RegisteredPlugin;
    readonly manifest: PluginManifest;
    readonly hash: string;
  }> {
    const record = this.#loaded.get(id)?.record;
    if (record === undefined) throw new NotFound(`No plugin "${id}" is installed`);
    const { manifest, hash } = await this.#readManifest(record.dir);
    if (manifest.id !== record.id) {
      throw new InvalidInput(
        `The manifest in ${record.dir} says id "${manifest.id}", not "${record.id}"`,
      );
    }
    return { record, manifest, hash };
  }

  // ----- listeners ---------------------------------------------------------------------------

  /**
   * Called after the set of active plugins of some project changed (install of an active
   * plugin's new manifest, remove, enable, disable, an edited folder, another process writing the
   * file): the holder of the registries builds a new snapshot, and P5 stops the processes that no
   * longer belong. Returns the function that removes the listener. A throwing listener is logged.
   */
  onChange(listener: PluginsChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /**
   * The extension point of P8: called for each fact of the registry, after the state is in place.
   * P8 turns the notices into `plugin.*` events; Phase 9 P4 only logs them. A notice is produced
   * by the process that SEES the change (the daemon sees the ones written by `ot plugin`, too).
   */
  onNotice(listener: PluginNoticeListener): () => void {
    this.#noticeListeners.add(listener);
    return () => this.#noticeListeners.delete(listener);
  }

  // ----- writes ------------------------------------------------------------------------------

  /**
   * Records an installed plugin (the files are already in place: the caller checked the manifest
   * and moved the folder). A new id is `installed`. An id that exists is `updated`: the
   * activations are kept, and those whose approved hash is not the new `manifestHash` wait for a
   * new approval, which is `needsApproval`.
   */
  async register(input: {
    readonly id: string;
    readonly version: string;
    readonly origin: PluginOrigin;
    readonly dir: string;
    readonly manifestHash: string;
  }): Promise<RegisterOutcome> {
    return await this.#mutate((file) => {
      const record: RegisteredPlugin = recordSchema.parse({
        id: input.id,
        version: input.version,
        origin: input.origin,
        dir: input.dir,
        manifestHash: input.manifestHash,
        installedAt: this.#clock.now(),
        projects: [],
      });
      const index = file.plugins.findIndex((plugin) => plugin.id === input.id);
      const previous = file.plugins[index];
      if (previous === undefined) {
        file.plugins.push(record);
        return { kind: 'installed', previous: undefined, needsApproval: [] } as const;
      }
      const kept = { ...record, projects: previous.projects };
      file.plugins[index] = kept;
      const needsApproval = kept.projects
        .filter((activation) => activation.approvedManifestHash !== input.manifestHash)
        .map((activation) => activation.project);
      return { kind: 'updated', previous, needsApproval } as const;
    });
  }

  /** Forgets a plugin and its activations. The caller removes the folder it owns. */
  async remove(id: string): Promise<RegisteredPlugin> {
    return await this.#mutate((file) => {
      const index = file.plugins.findIndex((plugin) => plugin.id === id);
      const record = file.plugins[index];
      if (record === undefined) throw new NotFound(`No plugin "${id}" is installed`);
      file.plugins.splice(index, 1);
      return record;
    });
  }

  /**
   * Turns a plugin on in a project, approving the manifest that is on disk now. `expectedHash` is
   * the hash of the manifest the Producer was shown: if the file changed meanwhile, it refuses with
   * `Conflict` and approves nothing. Turning on what is already on (same hash) changes nothing.
   */
  async enable(
    id: string,
    project: string,
    expectedHash?: string,
  ): Promise<{
    readonly changed: boolean;
    readonly manifest: PluginManifest;
    readonly hash: string;
  }> {
    assertProject(project);
    return await this.#mutate(async (file) => {
      const record = file.plugins.find((plugin) => plugin.id === id);
      if (record === undefined) throw new NotFound(`No plugin "${id}" is installed`);
      const { manifest, hash } = await this.#readManifest(record.dir);
      if (manifest.id !== id) {
        throw new InvalidInput(
          `The manifest in ${record.dir} says id "${manifest.id}", not "${id}"`,
        );
      }
      if (expectedHash !== undefined && expectedHash !== hash) {
        throw new Conflict(
          `The plugin.yaml of "${id}" changed after it was shown: look at it again before approving`,
        );
      }
      const current = record.projects.find((activation) => activation.project === project);
      if (current?.approvedManifestHash === hash) return { changed: false, manifest, hash };
      const activation = { project, approvedManifestHash: hash, approvedAt: this.#clock.now() };
      if (current === undefined) record.projects.push(activation);
      else Object.assign(current, activation);
      return { changed: true, manifest, hash };
    });
  }

  /** Turns a plugin off in a project. `false` when it was not on there. */
  async disable(id: string, project: string): Promise<boolean> {
    assertProject(project);
    return await this.#mutate((file) => {
      const record = file.plugins.find((plugin) => plugin.id === id);
      if (record === undefined) throw new NotFound(`No plugin "${id}" is installed`);
      const before = record.projects.length;
      record.projects = record.projects.filter((activation) => activation.project !== project);
      return record.projects.length !== before;
    });
  }

  // ----- reload ------------------------------------------------------------------------------

  /**
   * Reads the file and the manifests again and, when something differs from memory, tells the
   * listeners. Never throws for a bad file or manifest: it logs, and the plugin is off.
   */
  async refresh(): Promise<void> {
    await this.#serial(async () => {
      let file: PluginsFile;
      try {
        file = await this.#readFile();
      } catch (error) {
        this.#logger?.error(
          { err: error },
          'plugins.json cannot be used: no plugin is on until it is fixed',
        );
        file = { version: PLUGINS_FILE_VERSION, plugins: [] };
      }
      await this.#apply(file);
    });
  }

  /**
   * Watches `plugins.json` (through its folder: the file is replaced, not edited) and refreshes
   * shortly after it changes, so `ot plugin` run in another terminal reaches the daemon. [proposta]
   * A change of a `plugin.yaml` alone (a local folder edited) is seen by the next {@link refresh}.
   */
  watch(debounceMs = 200): void {
    if (this.#watcher !== undefined) return;
    try {
      this.#watcher = watch(dirname(this.#paths.file), { persistent: false }, (_event, name) => {
        if (name !== null && name !== 'plugins.json') return;
        if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => {
          this.#watchTimer = undefined;
          void this.refresh().catch((error: unknown) => {
            this.#logger?.error({ err: error }, 'refresh of the plugins failed');
          });
        }, debounceMs);
      });
      this.#watcher.on('error', (error) => {
        this.#logger?.warn({ err: error }, 'the watch of plugins.json stopped');
      });
    } catch (error) {
      this.#logger?.warn({ err: error }, 'plugins.json is not watched: restart to see changes');
    }
  }

  /** Stops the watch and drops the listeners. */
  close(): void {
    if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#noticeListeners.clear();
    this.#changeListeners.clear();
  }

  // ----- internals ---------------------------------------------------------------------------

  #readManifest(dir: string): ReturnType<typeof readPluginManifest> {
    return readPluginManifest(dir, { frameworkToolNames: this.#frameworkToolNames });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The file as it is now; a missing file is an empty registry. */
  async #readFile(): Promise<PluginsFile> {
    let text: string;
    try {
      text = await readFile(this.#paths.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PLUGINS_FILE_VERSION, plugins: [] };
      }
      throw new InvalidInput(`Cannot read ${this.#paths.file}: ${String(error)}`, { cause: error });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InvalidInput(`${this.#paths.file} is not valid JSON: ${String(error)}`, {
        cause: error,
      });
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; ');
      throw new InvalidInput(`${this.#paths.file} is not a valid plugin registry: ${issues}`);
    }
    return parsed.data;
  }

  /** Under the lock: read strictly, change a copy, write atomically, load the result. */
  #mutate<T>(change: (file: PluginsFile) => T | Promise<T>): Promise<T> {
    return this.#serial(async () => {
      await mkdir(dirname(this.#paths.file), { recursive: true });
      const release = await this.#lock();
      try {
        const file = await this.#readFile();
        const draft = structuredClone(file);
        const result = await change(draft);
        // Duplicate ids can only come from a bug here; the schema cannot see them.
        if (new Set(draft.plugins.map((plugin) => plugin.id)).size !== draft.plugins.length) {
          throw new InvalidInput('A plugin id appears twice in the registry');
        }
        await this.#writeFile(fileSchema.parse(draft));
        await this.#apply(draft);
        return result;
      } finally {
        await release();
      }
    });
  }

  /**
   * A temporary file renamed over `plugins.json`, so a reader never sees half a file. The rename is
   * retried while Windows refuses it because another handle (a `watch()` of another registry, an
   * antivirus) has the file open.
   */
  async #writeFile(file: PluginsFile): Promise<void> {
    await writePrivateFileAtomic(this.#paths.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * The lock between processes (the daemon and an `ot plugin` command): a file created with
   * `wx`, holding the time it was taken. Waits up to about 5 s, takes over a lock older than
   * `lockStaleMs`, and gives up with `Conflict` after that.
   */
  async #lock(): Promise<() => Promise<void>> {
    const token = randomBytes(8).toString('hex');
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        const handle = await open(this.#paths.lock, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ token, at: this.#clock.now() }));
        } finally {
          await handle.close();
        }
        return async () => {
          // Another process may have taken over a stale lock: only remove our own.
          try {
            const held = JSON.parse(await readFile(this.#paths.lock, 'utf8')) as {
              token?: unknown;
            };
            if (held.token === token) await rm(this.#paths.lock, { force: true });
          } catch {
            // Already gone.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = await this.#lockState();
      if (held === 'gone') continue;
      if (held === 'stale') {
        await rm(this.#paths.lock, { force: true });
        continue;
      }
      await this.#clock.sleep(LOCK_RETRY_MS);
    }
    throw new Conflict(
      `${this.#paths.lock} is held by another process: wait for it, or remove the file if no ot command is running`,
    );
  }

  /** `gone` (released meanwhile), `stale` (older than the limit) or `held`. */
  async #lockState(): Promise<'gone' | 'stale' | 'held'> {
    let text: string;
    try {
      text = await readFile(this.#paths.lock, 'utf8');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'stale';
    }
    try {
      const held = JSON.parse(text) as { at?: unknown };
      const old = typeof held.at === 'number' && this.#clock.now() - held.at > this.#lockStaleMs;
      return old ? 'stale' : 'held';
    } catch {
      // Half written by a process that has just taken it: wait, do not take it over.
      return 'held';
    }
  }

  /** Loads the manifests of a file's plugins, compares with memory, swaps, and tells. */
  async #apply(file: PluginsFile): Promise<void> {
    const next = new Map<string, Loaded>();
    for (const record of file.plugins) {
      next.set(record.id, await this.#load(record));
    }
    const previous = this.#loaded;
    const previousActive = this.#active;
    const active = computeActive(next);
    this.#loaded = next;
    this.#active = active;
    const notices = diffNotices(previous, next);
    for (const notice of notices) this.#announce(notice);
    const change = diffActive(previousActive, active);
    if (change !== undefined) {
      for (const listener of [...this.#changeListeners]) {
        try {
          listener(change);
        } catch (error) {
          this.#logger?.error({ err: error }, 'a listener of the plugin changes threw');
        }
      }
    }
  }

  async #load(record: RegisteredPlugin): Promise<Loaded> {
    if (record.origin.kind !== 'path' && !isInside(this.#paths.dir, record.dir)) {
      return {
        record,
        manifest: undefined,
        currentHash: undefined,
        problem: `the folder ${record.dir} is outside ${this.#paths.dir}`,
      };
    }
    try {
      const { manifest, hash } = await this.#readManifest(record.dir);
      if (manifest.id !== record.id) {
        return {
          record,
          manifest: undefined,
          currentHash: hash,
          problem: `the manifest says id "${manifest.id}", not "${record.id}"`,
        };
      }
      return { record, manifest, currentHash: hash, problem: undefined };
    } catch (error) {
      return {
        record,
        manifest: undefined,
        currentHash: undefined,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #announce(notice: PluginNotice): void {
    const log = this.#logger;
    if (log !== undefined) {
      if (notice.kind === 'needs_approval' || notice.kind === 'broken')
        log.warn(notice, `plugin ${notice.kind}`);
      else log.info(notice, `plugin ${notice.kind}`);
    }
    for (const listener of [...this.#noticeListeners]) {
      try {
        listener(notice);
      } catch (error) {
        log?.error({ err: error }, 'a listener of the plugin notices threw');
      }
    }
  }
}

const NO_PLUGINS: readonly ActivePlugin[] = Object.freeze([]);

function assertProject(project: string): void {
  if (!PROJECT_PATTERN.test(project) || project === '__proto__') {
    throw new InvalidInput(
      `"${project}" is not a project id (letters, digits, ".", "_", ":" and "-"; up to 128)`,
    );
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/** Active in a project: on there, the manifest valid, and the hash on disk the one approved. */
function stateOf(loaded: Loaded, approved: string): PluginProjectState {
  if (loaded.problem !== undefined || loaded.manifest === undefined) return 'broken';
  return loaded.currentHash === approved ? 'active' : 'needs_approval';
}

function viewOf(loaded: Loaded): PluginView {
  const { record } = loaded;
  return Object.freeze({
    id: record.id,
    version: record.version,
    origin: record.origin,
    dir: record.dir,
    installedAt: record.installedAt,
    manifestHash: record.manifestHash,
    currentManifestHash: loaded.currentHash,
    manifest: loaded.manifest,
    problem: loaded.problem,
    projects: record.projects
      .map((activation) => ({
        project: activation.project,
        state: stateOf(loaded, activation.approvedManifestHash),
      }))
      .sort((a, b) => a.project.localeCompare(b.project)),
  });
}

function computeActive(
  loaded: ReadonlyMap<string, Loaded>,
): ReadonlyMap<string, readonly ActivePlugin[]> {
  const byProject = new Map<string, ActivePlugin[]>();
  for (const entry of [...loaded.values()].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
    const { manifest, currentHash } = entry;
    if (entry.problem !== undefined || manifest === undefined || currentHash === undefined)
      continue;
    for (const activation of entry.record.projects) {
      if (activation.approvedManifestHash !== currentHash) continue;
      const list = byProject.get(activation.project) ?? [];
      list.push(
        Object.freeze({
          id: entry.record.id,
          version: entry.record.version,
          manifest,
          dir: entry.record.dir,
          manifestHash: currentHash,
        }),
      );
      byProject.set(activation.project, list);
    }
  }
  const frozen = new Map<string, readonly ActivePlugin[]>();
  for (const [project, list] of byProject) frozen.set(project, Object.freeze(list));
  return frozen;
}

/** The notices that take the state `before` to the state `after`. */
function diffNotices(
  before: ReadonlyMap<string, Loaded>,
  after: ReadonlyMap<string, Loaded>,
): PluginNotice[] {
  const notices: PluginNotice[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was === undefined) {
      notices.push({ kind: 'installed', id, version: now.record.version });
    } else if (
      was.record.version !== now.record.version ||
      was.record.manifestHash !== now.record.manifestHash ||
      was.record.dir !== now.record.dir
    ) {
      notices.push({ kind: 'updated', id, version: now.record.version });
    }
    const wasProjects = new Map(was?.record.projects.map((a) => [a.project, a]));
    const nowProjects = new Map(now.record.projects.map((a) => [a.project, a]));
    for (const project of nowProjects.keys()) {
      if (!wasProjects.has(project)) notices.push({ kind: 'enabled', id, project });
    }
    for (const project of wasProjects.keys()) {
      if (!nowProjects.has(project)) notices.push({ kind: 'disabled', id, project });
    }
    // Newly waiting for an approval: it was not waiting before, and it is now.
    const waiting = (loaded: Loaded | undefined): Set<string> =>
      new Set(
        (loaded?.record.projects ?? [])
          .filter(
            (a) =>
              loaded !== undefined && stateOf(loaded, a.approvedManifestHash) === 'needs_approval',
          )
          .map((a) => a.project),
      );
    const wasWaiting = waiting(was);
    const newlyWaiting = [...waiting(now)].filter((project) => !wasWaiting.has(project)).sort();
    if (newlyWaiting.length > 0)
      notices.push({ kind: 'needs_approval', id, projects: newlyWaiting });
    if (now.problem !== undefined && now.problem !== was?.problem) {
      notices.push({ kind: 'broken', id, problem: now.problem });
    }
  }
  for (const [id, was] of before) {
    if (!after.has(id)) notices.push({ kind: 'removed', id, version: was.record.version });
  }
  return notices;
}

function fingerprint(plugin: ActivePlugin): string {
  return `${plugin.id}\0${plugin.version}\0${plugin.manifestHash}\0${plugin.dir}`;
}

function diffActive(
  before: ReadonlyMap<string, readonly ActivePlugin[]>,
  after: ReadonlyMap<string, readonly ActivePlugin[]>,
): PluginsChange | undefined {
  const projects = new Set<string>();
  const plugins = new Set<string>();
  for (const project of new Set([...before.keys(), ...after.keys()])) {
    const was = new Map((before.get(project) ?? []).map((p) => [p.id, fingerprint(p)]));
    const now = new Map((after.get(project) ?? []).map((p) => [p.id, fingerprint(p)]));
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(id) !== now.get(id)) {
        projects.add(project);
        plugins.add(id);
      }
    }
  }
  if (projects.size === 0) return undefined;
  return Object.freeze({ projects: [...projects].sort(), plugins: [...plugins].sort() });
}
