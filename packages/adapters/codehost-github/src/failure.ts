// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  Transient,
} from '@otheater/core';
import type { ToolResult } from './runner.js';

/** Longest part of a tool's message kept in an error. */
const MAX_DETAIL_CHARS = 500;

function detailOf(result: ToolResult): string {
  const text = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...` : text;
}

/**
 * Maps a failed `git push` to the typed error of the port's contract. The patterns are the
 * messages of git in the C locale (the runner sets `LC_ALL=C`).
 */
export function classifyPushFailure(branch: string, result: ToolResult): Error {
  const text = result.stderr;
  const message = `git push of ${branch} failed: ${detailOf(result)}`;
  if (
    /non-fast-forward|fetch first|\[rejected\]|tip of your current branch is behind/i.test(text)
  ) {
    return new Conflict(message);
  }
  return classifyCommon(message, text);
}

/** Maps a failed `gh` call (or `git ls-remote`) to the typed error of the port's contract. */
export function classifyToolFailure(what: string, result: ToolResult): Error {
  const text = `${result.stderr}\n${result.stdout}`;
  const message = `${what} failed: ${detailOf(result)}`;
  if (/already exists/i.test(text)) return new Conflict(message);
  if (/HTTP 409|merge conflict/i.test(text)) return new Conflict(message);
  if (/No commits between|nothing to compare/i.test(text)) return new InvalidInput(message);
  if (
    /Head ref must be a branch|Head sha can't be blank|HTTP 404|Not Found|Could not resolve to a/i.test(
      text,
    )
  ) {
    return new NotFound(message);
  }
  return classifyCommon(message, text);
}

function classifyCommon(message: string, text: string): Error {
  if (
    /authentication|auth login|HTTP 40[13]|permission denied|could not read username|bad credentials|resource not accessible|protected branch|publickey/i.test(
      text,
    )
  ) {
    return new PermissionDenied(message);
  }
  if (
    /HTTP 5\d\d|HTTP 429|rate limit|timed out|timeout|could not resolve host|connection (refused|reset)|network is unreachable|unable to access|temporary failure/i.test(
      text,
    )
  ) {
    return new Transient(message);
  }
  if (
    /does not appear to be a git repository|no such remote|no git remotes|not a git repository/i.test(
      text,
    )
  ) {
    return new NotFound(message);
  }
  return new AdapterUnavailable(message);
}
