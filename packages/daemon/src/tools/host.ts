// SPDX-License-Identifier: MPL-2.0
import { lstat, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { PathHost } from '@otheater/core';

/**
 * The file system as the confinement of the shell tools asks about it (`PathHost` of `core`): the
 * real `realpath` and `lstat` of the machine. Case sensitivity follows the platform (Windows and
 * macOS compare names without regard to case).
 */
export function nodePathHost(platform: NodeJS.Platform = process.platform): PathHost {
  return {
    sep: sep === '\\' ? '\\' : '/',
    caseInsensitive: platform === 'win32' || platform === 'darwin',
    realpath: (path) => realpath(path),
    isSymlink: async (path) => {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
      }
    },
  };
}
