// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';

/**
 * Absolute paths in the text of an error answer. An answer of the API goes to a client that may be a
 * browser page, and an absolute path says who the user is and how the machine is laid out, so it is
 * not part of what the daemon tells. The logs keep the whole message.
 *
 * - POSIX: a `/` that starts a word (not `a/b`, not the path of a URL, not `text/plain`), then its
 *   segments; a path after `=` or `:` (`cwd=/x`, `error:/x`) is redacted as well;
 * - Windows: a drive (`C:\` or `C:/`) or a UNC share (`\\server\share`);
 * - `file://` URLs, which hold a path of either kind.
 *
 * A path with a space in it is cut at the space: what is left is a name, never a directory.
 */
const FILE_URL = /file:\/\/[^\s"'`<>|*?]+/gi;
const WINDOWS_PATH = /(?<![\w])[A-Za-z]:[\\/][^\s"'`<>|*?]*/g;
const UNC_PATH = /\\\\[^\s"'`<>|*?\\]+(?:\\[^\s"'`<>|*?\\]*)*/g;
const POSIX_PATH = /(?<![\w.~/@%+-])\/(?:[\w.@%+=~-]+\/)*[\w.@%+=~-]+/g;

/** What an absolute path becomes in an answer. */
export const REDACTED_PATH = '<path>';

/** `text` with every absolute path replaced by {@link REDACTED_PATH}. */
export function redactPaths(text: string): string {
  return text
    .replaceAll(FILE_URL, REDACTED_PATH)
    .replaceAll(WINDOWS_PATH, REDACTED_PATH)
    .replaceAll(UNC_PATH, REDACTED_PATH)
    .replaceAll(POSIX_PATH, REDACTED_PATH);
}

/** The same for every string of a JSON value (the `details` of an error). */
export function redactPathsIn(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactPaths(value);
  if (Array.isArray(value)) return value.map(redactPathsIn);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactPathsIn(child)]),
    );
  }
  return value;
}

/** The `details` of an error with the paths redacted. */
export function redactDetails(
  details: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (details === undefined) return undefined;
  return redactPathsIn(details) as Record<string, JsonValue>;
}
