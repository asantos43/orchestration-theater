// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MAX_FILE_BYTES } from './format.js';

/** `true` for an error carrying this errno code (`ENOENT`...). */
export function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

/** The file's text, or `undefined` when it does not exist. */
export async function readVaultFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) {
      throw new RangeError(`vault file larger than ${String(MAX_FILE_BYTES)} bytes`);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** Creates the directory of `path` with mode 0700 when it is missing. An existing one is kept. */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

/**
 * Replaces the file atomically: write a temporary file in the same directory (mode 0600), fsync
 * it, rename it over the target, fsync the directory. A reader sees the old or the new content,
 * never a mix, and a crash leaves at most a stray `.tmp` (removed here on every failure we see).
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

/** fsync of a directory makes the rename durable. Platforms that cannot open one are skipped. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, 'EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
