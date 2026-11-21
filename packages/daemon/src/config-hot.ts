// SPDX-License-Identifier: MPL-2.0
import type { DaemonConfig } from './config.js';

/**
 * The hot reload of the configuration (P16 of Phase 7, N188). [proposta] The daemon keeps the
 * configuration it started with, and `PUT /v1/config` edits the file. The sections below can change
 * with the daemon running, because everything that reads them reads at the moment of use (or
 * through a getter the daemon wires for the few values it copies): `ui.*`, `chat.*`, `limits.*` and
 * `roles.*`. Every other key (adapters, pool, store, api...) shapes something built at the start,
 * so it keeps the old value until a restart and the answer says so.
 *
 * P23 of Phase 7 (N208 item 3, N202 (c)): the setup assistant and the cadastro of an Executor write
 * the file too, and they go through the same reload ({@link createConfigReloader}). What they write
 * besides `roles.*` is `executors.*` and, in `profiles.<id>`, the `budget` and the `local` blocks:
 * all of them are read at the moment of use (the catalog of the Executors, the lists, the usage
 * routes) or handed to the one service that copies them (the spending caps), so they join the hot
 * paths. `profiles.<id>.codex_link` and the fixed keys of `profiles` (`drain`, `shims`...) shape
 * what the start builds and stay for the restart. Editing the file by hand stays a restart.
 *
 * The reload replaces the sections IN PLACE, so every service that holds the `config` object sees
 * the new values without being told. A play already open keeps the limits it opened with (the play
 * copies `limits.*` when it opens), which is how `limits` always worked.
 */

/** The sections of `DaemonConfig` that a running daemon takes in without a restart. */
export const HOT_CONFIG_SECTIONS = ['ui', 'chat', 'limits', 'roles'] as const;
export type HotConfigSection = (typeof HOT_CONFIG_SECTIONS)[number];

/** The blocks of `profiles.<id>` that a running daemon takes in (the other one, `codex_link`, wires the quota at the start). */
const HOT_PROFILE_BLOCKS: readonly string[] = ['budget', 'local'];

/**
 * Whether the dotted key path applies without a restart: the four sections, `executors.*`, and the
 * `budget` and `local` blocks of a profile (`profiles.<client>/<name>.budget...`). A profile name
 * with a dot cannot be told from a deeper key, so its path is the conservative answer (restart).
 */
export function isHotPath(path: string): boolean {
  const [head = '', second, third] = path.split('.');
  if ((HOT_CONFIG_SECTIONS as readonly string[]).includes(head)) return true;
  if (head === 'executors') return true;
  if (head === 'profiles' && second?.includes('/') === true) {
    return third === undefined || HOT_PROFILE_BLOCKS.includes(third);
  }
  return false;
}

/** The dotted paths split into the ones that apply at once and the ones that wait for a restart. */
export function splitByReload(paths: readonly string[]): { hot: string[]; restart: string[] } {
  const hot: string[] = [];
  const restart: string[] = [];
  for (const path of paths) (isHotPath(path) ? hot : restart).push(path);
  return { hot, restart };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Makes `target` equal to `source`, keeping the identity of every object that exists in both. */
function syncInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the live object must lose the keys the file no longer has
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) syncInPlace(current, value);
    else target[key] = value;
  }
}

function syncSection(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
) {
  const current = target[key];
  const value = source[key];
  if (isPlainObject(current) && isPlainObject(value)) syncInPlace(current, value);
  else target[key] = value;
}

/** Makes the hot blocks of every profile of `live` equal to the ones of `next`; the rest of `profiles` is left alone. */
function syncProfileEntries(live: DaemonConfig, next: DaemonConfig): void {
  const target = live.profiles.entries as Record<string, Record<string, unknown>>;
  const source = next.profiles.entries as Record<string, Record<string, unknown>>;
  for (const id of Object.keys(target)) {
    if (id in source) continue;
    // A profile the file no longer has keeps only what the restart owns (`codex_link`).
    const entry = target[id];
    if (entry === undefined) continue;
    for (const block of HOT_PROFILE_BLOCKS) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the live object must lose the blocks the file no longer has
      delete entry[block];
    }
    if (Object.keys(entry).length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- same: the profile block is gone from the file
      delete target[id];
    }
  }
  for (const [id, entry] of Object.entries(source)) {
    const current = (target[id] ??= {});
    for (const block of HOT_PROFILE_BLOCKS) {
      if (block in entry) current[block] = entry[block];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the live object must lose the blocks the file no longer has
      else delete current[block];
    }
  }
}

/**
 * Copies the hot parts of `next` (the validated result of an edit) into `live`, the object the
 * daemon runs with: the four sections of {@link HOT_CONFIG_SECTIONS}, plus `executors` and the
 * `budget` and `local` blocks of the profiles when `hot` (the paths that changed) says one of them
 * did, or always when `hot` is left out. Nothing else is touched.
 */
export function applyHotSections(
  live: DaemonConfig,
  next: DaemonConfig,
  hot?: readonly string[],
): void {
  const target = live as unknown as Record<string, unknown>;
  const source = next as unknown as Record<string, unknown>;
  const touches = (head: string): boolean =>
    hot === undefined || hot.some((path) => path.split('.')[0] === head);
  for (const section of HOT_CONFIG_SECTIONS) syncSection(target, source, section);
  if (touches('executors')) syncSection(target, source, 'executors');
  if (touches('profiles')) syncProfileEntries(live, next);
}
