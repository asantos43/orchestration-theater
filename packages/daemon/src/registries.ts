// SPDX-License-Identifier: MPL-2.0
import {
  buildRegistries,
  officialRegistryEntries,
  type Registries,
  type RegistryEntries,
} from '@otheater/core';
import { DAEMON_EVENT_DEFINITIONS } from '@otheater/protocol';
import { assertPlayFlowLinked } from './pipeline/flows.js';
import { PLAY_EVENT_DEFINITIONS } from './pipeline/events.js';
import type { Logger } from './logger.js';
import type { ActivePlugin, PluginRegistry } from './plugins/registry.js';

/**
 * The registries the daemon starts with (architecture 5.18, "Registros"): the official roles,
 * tools, `rule` keys, flows and scenario types of `@otheater/core`, the event types of
 * `@otheater/protocol` and the 2 of the play machine (`play.created`, `play.transitioned`).
 * Plugin entries join here when the plugin steps arrive.
 */
export function defaultRegistryEntries(): RegistryEntries {
  return officialRegistryEntries([...DAEMON_EVENT_DEFINITIONS, ...PLAY_EVENT_DEFINITIONS]);
}

/**
 * Builds and validates the registries. Runs at start-up, before the store is opened: a problem
 * rejects with `InvalidInput` listing every entry that failed (registry and entry named), and
 * the daemon does not start.
 */
export function buildDaemonRegistries(
  entries: RegistryEntries = defaultRegistryEntries(),
): Registries {
  const registries = buildRegistries(entries);
  // The `play` entry of the flow registry is the descriptor of the machine in `./pipeline`.
  assertPlayFlowLinked(registries);
  return registries;
}

/**
 * The frozen snapshot of the registries and of the plugins that are active when it was made
 * (Phase 9, P4; N235 (a)). A session takes it once, when it opens, and keeps it until it ends: a
 * later `ot plugin enable` or `disable` makes a NEW snapshot for the sessions that open after, and
 * never changes this one.
 */
export interface RegistrySnapshot {
  /** 0 for the one the daemon started with; each swap adds 1. */
  readonly generation: number;
  readonly registries: Registries;
  /** The active plugins of each project at the moment of the snapshot (frozen). */
  readonly plugins: ReadonlyMap<string, readonly ActivePlugin[]>;
}

/**
 * What a later step adds to the registries for the plugins that are active (the tools of a plugin
 * in P6, its `plugin.<id>.<name>` events in P8, the panel entries in P12). P4 registers none: the
 * holder only has the extension point. A contributor must be pure (the same input, the same
 * output) because it runs again at every swap.
 */
export type RegistryContributor = (
  plugins: ReadonlyMap<string, readonly ActivePlugin[]>,
) => Partial<RegistryEntries>;

export type RegistrySwapListener = (snapshot: RegistrySnapshot) => void;

export interface RegistryHolderOptions {
  /** The entries of the daemon without plugins (default: {@link defaultRegistryEntries}). */
  readonly base?: RegistryEntries | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Keeps the current {@link RegistrySnapshot} and swaps it when the active plugins change. With no
 * contributor the registries do not change at a swap (the same frozen object is reused), so a
 * daemon without plugin steps behaves exactly as before.
 */
export class RegistryHolder {
  readonly #base: RegistryEntries;
  readonly #logger: Logger | undefined;
  readonly #contributors: RegistryContributor[] = [];
  readonly #listeners = new Set<RegistrySwapListener>();
  #snapshot: RegistrySnapshot;
  #unsubscribe: (() => void) | undefined;

  constructor(registries: Registries, options: RegistryHolderOptions = {}) {
    this.#base = options.base ?? defaultRegistryEntries();
    this.#logger = options.logger;
    this.#snapshot = Object.freeze({ generation: 0, registries, plugins: NO_PLUGINS });
  }

  /** The snapshot in force now. A session reads it once, at its start, and keeps the object. */
  current(): RegistrySnapshot {
    return this.#snapshot;
  }

  /** Calls `listener` after each swap; returns the function that removes it. */
  onSwap(listener: RegistrySwapListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The extension point of P6, P8 and P12. Takes effect at the next swap (see {@link swap}). */
  contribute(contributor: RegistryContributor): void {
    this.#contributors.push(contributor);
  }

  /**
   * Follows the plugin registry: every change of the active plugins makes a new snapshot. Calling
   * it again replaces the earlier subscription.
   */
  follow(plugins: Pick<PluginRegistry, 'activeSnapshot' | 'onChange'>): void {
    this.#unsubscribe?.();
    this.swap(plugins.activeSnapshot());
    this.#unsubscribe = plugins.onChange(() => {
      this.swap(plugins.activeSnapshot());
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#listeners.clear();
  }

  /**
   * Makes the next snapshot from the active plugins. When a contributor's entries do not pass the
   * validation, the swap is refused (the current snapshot stays) and the reason is logged: a bad
   * plugin never leaves the daemon without registries.
   */
  swap(plugins: ReadonlyMap<string, readonly ActivePlugin[]>): void {
    let registries = this.#snapshot.registries;
    if (this.#contributors.length > 0) {
      try {
        registries = buildDaemonRegistries(mergeEntries(this.#base, this.#contributors, plugins));
      } catch (error) {
        this.#logger?.warn({ err: error }, 'the registries swap was refused; the snapshot stays');
        return;
      }
    }
    const next: RegistrySnapshot = Object.freeze({
      generation: this.#snapshot.generation + 1,
      registries,
      plugins,
    });
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (error) {
        this.#logger?.error({ err: error }, 'a listener of the registries swap threw');
      }
    }
  }
}

const NO_PLUGINS: ReadonlyMap<string, readonly ActivePlugin[]> = new Map();

function mergeEntries(
  base: RegistryEntries,
  contributors: readonly RegistryContributor[],
  plugins: ReadonlyMap<string, readonly ActivePlugin[]>,
): RegistryEntries {
  const merged = { ...base };
  for (const contributor of contributors) {
    const extra = contributor(plugins);
    for (const key of Object.keys(extra) as (keyof RegistryEntries)[]) {
      const more = extra[key];
      if (more === undefined) continue;
      (merged as Record<string, unknown>)[key] = [
        ...(merged[key] as readonly unknown[]),
        ...(more as readonly unknown[]),
      ];
    }
  }
  return merged;
}
