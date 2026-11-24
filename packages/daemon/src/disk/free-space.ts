// SPDX-License-Identifier: MPL-2.0
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The bytes a process without privilege can still write on the file system that holds `path`
 * (`statfs`: the blocks available times their size). A path that does not exist yet is read through
 * its nearest parent. `undefined` when the system cannot tell (a platform without `statfs`, a
 * permission problem): an unknown answer never counts as a full disk.
 */
export async function freeBytesOf(path: string): Promise<number | undefined> {
  let current = path;
  for (;;) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** `256 MB` for a message: the size in the largest binary unit that keeps it above one. */
export function sizeText(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit] ?? 'B'}`;
}
