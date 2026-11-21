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
 * The reload replaces the sections IN PLACE, so every service that holds the `config` object sees
 * the new values without being told. A play already open keeps the limits it opened with (the play
 * copies `limits.*` when it opens), which is how `limits` always worked.
 */

/** The sections of `DaemonConfig` that a running daemon takes in without a restart. */
export const HOT_CONFIG_SECTIONS = ['ui', 'chat', 'limits', 'roles'] as const;
export type HotConfigSection = (typeof HOT_CONFIG_SECTIONS)[number];

export function isHotPath(path: string): boolean {
  const head = path.split('.')[0] ?? '';
  return (HOT_CONFIG_SECTIONS as readonly string[]).includes(head);
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
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) syncInPlace(current, value);
    else target[key] = value;
  }
}

/**
 * Copies the hot sections of `next` (the validated result of an edit) into `live`, the object the
 * daemon runs with. Nothing outside {@link HOT_CONFIG_SECTIONS} is touched.
 */
export function applyHotSections(live: DaemonConfig, next: DaemonConfig): void {
  const target = live as unknown as Record<string, unknown>;
  const source = next as unknown as Record<string, unknown>;
  for (const section of HOT_CONFIG_SECTIONS) {
    const current = target[section];
    const value = source[section];
    if (isPlainObject(current) && isPlainObject(value)) syncInPlace(current, value);
    else target[section] = value;
  }
}
