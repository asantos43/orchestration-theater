// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compareStrings, toPosix, type ExecFn } from './common.js';

/**
 * Files tracked by git, plus new files not yet added (and not ignored), so the checks also see work in progress.
 * In CI (a clean checkout) this is exactly `git ls-files`. Paths are repository-relative with forward slashes.
 */
export async function listRepositoryFiles(exec: ExecFn, root: string): Promise<string[]> {
  const stdout = await exec(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root },
  );
  return [
    ...new Set(
      stdout
        .split('\0')
        .filter((p) => p !== '')
        .map(toPosix),
    ),
  ].sort(compareStrings);
}

export interface SourceFile {
  path: string;
  content: string;
}

/** Reads the given files as UTF-8; a path that no longer exists on disk (deleted, not yet staged) is skipped. */
export function readTextFiles(root: string, paths: readonly string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const p of paths) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(path.join(root, p));
    } catch {
      continue;
    }
    // A NUL byte in the first bytes means a binary file.
    if (buffer.subarray(0, 8000).includes(0)) continue;
    files.push({ path: p, content: buffer.toString('utf8') });
  }
  return files;
}

export function isInside(file: string, directoryName: string): boolean {
  return file.split('/').slice(0, -1).includes(directoryName);
}
