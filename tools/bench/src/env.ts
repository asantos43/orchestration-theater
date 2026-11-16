// SPDX-License-Identifier: MPL-2.0
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SqliteStore, type SqliteDriverName } from '@otheater/adapter-store-sqlite';
import { DRIVERS, systemClock } from './common.js';
import type { MountEntry } from './fs-guard.js';

/** Mount options worth recording: they change how a disk write behaves. */
const RELEVANT_MOUNT_OPTIONS =
  /^(compress(-force)?(=.*)?|nodatacow|nodatasum|ssd|discard(=.*)?|sync|dirsync|data=.*|barrier|nobarrier)$/;

export interface Environment {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly kernel: string;
  readonly cpuModel: string;
  readonly cpuThreads: number;
  readonly ramGiB: number;
  readonly filesystem: {
    readonly type: string;
    readonly options: readonly string[];
  };
  readonly disk: {
    readonly model: string | undefined;
    readonly rotational: boolean | undefined;
  };
  readonly drivers: Readonly<
    Record<SqliteDriverName, { readonly sqlite: string; readonly package: string }>
  >;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** Model and rotational flag of the disk behind a `/dev/...` source, from `/sys` (best effort). */
async function diskOf(
  source: string,
): Promise<{ model: string | undefined; rotational: boolean | undefined }> {
  const none = { model: undefined, rotational: undefined };
  if (!source.startsWith('/dev/')) return none;
  try {
    const node = await realpath(join('/sys/class/block', basename(source)));
    // A partition sits one level below its disk.
    const isPartition = await stat(join(node, 'partition')).then(
      () => true,
      () => false,
    );
    const disk = isPartition ? dirname(node) : node;
    const model = await readText(join(disk, 'device', 'model'));
    const rotational = await readText(join(disk, 'queue', 'rotational'));
    return {
      model: model === undefined || model === '' ? undefined : model,
      rotational: rotational === undefined ? undefined : rotational === '1',
    };
  } catch {
    return none;
  }
}

/** Version of the `better-sqlite3` package, resolved from the adapter that depends on it. */
async function betterSqlite3Version(): Promise<string> {
  const adapter = import.meta.resolve('@otheater/adapter-store-sqlite');
  const require = createRequire(adapter);
  const manifest = JSON.parse(
    await readFile(require.resolve('better-sqlite3/package.json'), 'utf8'),
  ) as { version: string };
  return `better-sqlite3 ${manifest.version}`;
}

async function probeDriver(dir: string, driver: SqliteDriverName): Promise<string> {
  const store = await SqliteStore.open(
    { path: join(dir, `probe-${driver}.db`), driver },
    systemClock,
  );
  try {
    return (await store.diagnostics()).sqliteVersion;
  } finally {
    await store.close();
  }
}

/** What the report says about the machine. No paths and no user names: only kinds and versions. */
export async function collectEnvironment(dir: string, mount: MountEntry): Promise<Environment> {
  const cpu = cpus();
  const sqlite: Partial<Record<SqliteDriverName, string>> = {};
  for (const driver of DRIVERS) sqlite[driver] = await probeDriver(dir, driver);
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    kernel: release(),
    cpuModel: cpu[0]?.model.trim() ?? 'unknown',
    cpuThreads: cpu.length,
    ramGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    filesystem: {
      type: mount.fsType,
      options: mount.options.filter((option) => RELEVANT_MOUNT_OPTIONS.test(option)),
    },
    disk: await diskOf(mount.source),
    drivers: {
      'better-sqlite3': {
        sqlite: sqlite['better-sqlite3'] ?? 'unknown',
        package: await betterSqlite3Version(),
      },
      'node-sqlite': {
        sqlite: sqlite['node-sqlite'] ?? 'unknown',
        package: `node:sqlite (built into Node ${process.version})`,
      },
    },
  };
}
