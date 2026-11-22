// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ADAPTER_LOCK_DATA } from './lock-data.js';

/**
 * The pinned manifest of the managed ACP adapters (Phase 10, P13; N254 revised, 2026-11-22). One lockfile
 * per adapter, with only the subtree of the adapter: path in `node_modules`, version, `sha512` integrity
 * and, for the packages of one platform, `os`/`cpu`/`libc`. The files are derived from the npm lockfiles
 * of the spikes by `node tools/verify/dist/cli.js adapter-locks`; the daemon only reads them.
 */

/** The adapters the daemon installs, by the npm package they come from. */
export const ADAPTER_IDS = ['claude-agent-acp', 'codex-acp'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

const stringList = z.array(z.string().min(1)).readonly();

const LockEntrySchema = z.strictObject({
  path: z.string().regex(/^node_modules\/[^\0]+$/u),
  name: z.string().min(1),
  version: z.string().min(1),
  resolved: z.string().optional(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/u),
  os: stringList.optional(),
  cpu: stringList.optional(),
  libc: stringList.optional(),
  optional: z.literal(true).optional(),
});

const AdapterLockSchema = z.strictObject({
  schema: z.literal(1),
  id: z.enum(ADAPTER_IDS),
  package: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().min(1),
  entries: z.array(LockEntrySchema).min(1).readonly(),
});

export type AdapterLockEntry = z.infer<typeof LockEntrySchema>;
export type AdapterLock = z.infer<typeof AdapterLockSchema>;

export function parseAdapterLock(value: unknown): AdapterLock {
  const lock = AdapterLockSchema.parse(value);
  const paths = new Set<string>();
  for (const entry of lock.entries) {
    if (paths.has(entry.path)) throw new Error(`${lock.id}: duplicate path ${entry.path}`);
    if (entry.path.split('/').includes('..')) throw new Error(`${lock.id}: bad path ${entry.path}`);
    paths.add(entry.path);
  }
  if (!paths.has(`node_modules/${lock.package}`))
    throw new Error(`${lock.id}: the lock does not list ${lock.package}`);
  return lock;
}

let cache: ReadonlyMap<AdapterId, AdapterLock> | undefined;

/** The locks the build carries. A malformed one is a build error, so it throws. */
export function adapterLocks(): ReadonlyMap<AdapterId, AdapterLock> {
  cache ??= new Map(ADAPTER_LOCK_DATA.map((raw) => parseAdapterLock(raw)).map((l) => [l.id, l]));
  return cache;
}

export function adapterLock(id: AdapterId): AdapterLock {
  const lock = adapterLocks().get(id);
  if (lock === undefined) throw new Error(`no lock for the adapter ${id}`);
  return lock;
}

/** The adapter file Node runs, relative to the installation: `node_modules/<package>/<entry>`. */
export function adapterLockEntryPath(lock: AdapterLock): string {
  return `node_modules/${lock.package}/${lock.entry}`;
}

/** What identifies the content of a lock: the marker of an install is valid only for the same digest. */
export function lockDigest(lock: AdapterLock): string {
  return createHash('sha256').update(JSON.stringify(lock)).digest('hex');
}

export interface InstallPlatform {
  readonly os: string;
  readonly cpu: string;
  /** `glibc` or `musl` on Linux; `undefined` elsewhere. */
  readonly libc?: string | undefined;
}

/** The npm rule: a package with `os`/`cpu`/`libc` is installed only where all of them match. */
export function matchesPlatform(entry: AdapterLockEntry, platform: InstallPlatform): boolean {
  const ok = (list: readonly string[] | undefined, value: string | undefined): boolean => {
    if (list === undefined || list.length === 0) return true;
    if (value === undefined) return true; // unknown libc: npm does not filter then
    const allowed = list.filter((item) => !item.startsWith('!'));
    const blocked = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
    return !blocked.includes(value) && (allowed.length === 0 || allowed.includes(value));
  };
  return ok(entry.os, platform.os) && ok(entry.cpu, platform.cpu) && ok(entry.libc, platform.libc);
}

/** The entries to install: the ones that fit the platform. A required package that does not fit is an error of the lock. */
export function entriesFor(lock: AdapterLock, platform: InstallPlatform): AdapterLockEntry[] {
  return lock.entries.filter((entry) => matchesPlatform(entry, platform));
}

/** The libc of this Linux: `musl` when Node is not linked against glibc. */
export function hostLibc(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc';
}

export function hostPlatform(): InstallPlatform {
  return { os: process.platform, cpu: process.arch, libc: hostLibc() };
}
