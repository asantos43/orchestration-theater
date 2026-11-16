// SPDX-License-Identifier: MPL-2.0
import { access, mkdir, readFile, realpath, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** One line of `/proc/mounts`. */
export interface MountEntry {
  readonly source: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly options: readonly string[];
}

/** Filesystems that live in RAM: `fsync` there costs nothing, so a durability benchmark is void. */
export const RAM_FILESYSTEMS: ReadonlySet<string> = new Set(['tmpfs', 'ramfs', 'devtmpfs']);

/** `f_type` magic numbers of `statfs(2)` for RAM filesystems (TMPFS_MAGIC, RAMFS_MAGIC). */
const RAM_FILESYSTEM_MAGIC: ReadonlySet<number> = new Set([0x01021994, 0x858458f6]);

export class UnsafeDirectoryError extends Error {
  override readonly name = 'UnsafeDirectoryError';
}

/** `/proc/mounts` escapes space, tab, newline and backslash as octal (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [source, mountPoint, fsType, options] = fields as [string, string, string, string];
    entries.push({
      source: unescapeMountField(source),
      mountPoint: unescapeMountField(mountPoint),
      fsType,
      options: options.split(','),
    });
  }
  return entries;
}

// `/proc/mounts` is a POSIX table, so its paths always use `/`, whatever the platform running this.
function isInside(path: string, mountPoint: string): boolean {
  if (mountPoint === '/') return true;
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

/**
 * The mount that holds `absolutePath`: the longest mount point that contains it; among equal mount
 * points the last line wins (a later mount covers an earlier one).
 */
export function findMount(
  mounts: readonly MountEntry[],
  absolutePath: string,
): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const mount of mounts) {
    if (!isInside(absolutePath, mount.mountPoint)) continue;
    if (best === undefined || mount.mountPoint.length >= best.mountPoint.length) best = mount;
  }
  return best;
}

/**
 * Throws `UnsafeDirectoryError` unless `realDir` (an absolute path with symlinks resolved) is on a
 * disk-backed filesystem according to `/proc/mounts` text. `statfsType` is the `f_type` of
 * `statfs(2)` for the same directory, when known: a second, independent check.
 */
export function assertRealDisk(
  realDir: string,
  mountsText: string,
  statfsType?: number,
): MountEntry {
  const mount = findMount(parseMounts(mountsText), realDir);
  if (mount === undefined) {
    throw new UnsafeDirectoryError(
      'Cannot tell which filesystem holds the directory (no matching line in /proc/mounts); refusing to run.',
    );
  }
  if (RAM_FILESYSTEMS.has(mount.fsType)) {
    throw new UnsafeDirectoryError(
      `The directory is on a ${mount.fsType} filesystem (RAM): fsync costs nothing there and the ` +
        'measurement would be meaningless. Use a directory on a real disk.',
    );
  }
  if (statfsType !== undefined && RAM_FILESYSTEM_MAGIC.has(statfsType)) {
    throw new UnsafeDirectoryError(
      'statfs(2) reports a RAM filesystem for the directory; use a directory on a real disk.',
    );
  }
  return mount;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface CheckedDirectory {
  /** Absolute path with symlinks resolved. */
  readonly realPath: string;
  readonly mount: MountEntry;
}

/**
 * Creates `dir` if missing and proves it is on a real disk. Only Linux is supported (the check
 * reads `/proc/mounts`); elsewhere it refuses rather than guess.
 */
export async function checkDirectory(
  dir: string,
  readMounts: () => Promise<string> = () => readFile('/proc/mounts', 'utf8'),
  platform: NodeJS.Platform = process.platform,
): Promise<CheckedDirectory> {
  if (platform !== 'linux') {
    throw new UnsafeDirectoryError(
      `Cannot verify the filesystem on ${platform} (only Linux is supported); refusing to run.`,
    );
  }
  // Check the nearest existing ancestor first, so a refused folder is never created.
  let probe = resolve(dir);
  while (!(await exists(probe))) probe = dirname(probe);
  const probeReal = await realpath(probe);
  assertRealDisk(probeReal, await readMounts(), (await statfs(probeReal)).type);
  await mkdir(dir, { recursive: true });
  const realPath = await realpath(dir);
  const { type } = await statfs(realPath);
  const mount = assertRealDisk(realPath, await readMounts(), type);
  return { realPath, mount };
}
