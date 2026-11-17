// SPDX-License-Identifier: MPL-2.0
import { realpathSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import type { NewEvent, PermissionOutcome } from '@otheater/core';
import { buildDaemonEvent, PERMISSION_EVENT_MAX_PATHS } from '@otheater/protocol';

/**
 * The events of layer 2 (architecture 5.8; Phase 4, P2): what the base of the `ClientAdapter` tells
 * the runner about a request it answered becomes `permission.asked` and `permission.answered`, in
 * that order, with the session and the attempt.
 */

/** Who the request belongs to: the session of the lease and the correlation of the attempt. */
export interface PermissionScope {
  readonly sessionId: string;
  readonly playId: string;
  readonly demandId: string;
  readonly attemptId: string;
}

/** The host of an address, lower case, or `undefined` when it is not an absolute URL. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { hostname } = new URL(url);
    return hostname === '' ? undefined : hostname.toLowerCase().slice(0, 256);
  } catch {
    return undefined;
  }
}

/** The two events of one request; `permission.asked` first. */
export function permissionEventsOf(
  outcome: PermissionOutcome,
  scope: PermissionScope,
): [NewEvent, NewEvent] {
  const { request } = outcome;
  const paths = (request.locations ?? [])
    .filter((path) => path.length > 0)
    .map((path) => path.slice(0, 1024));
  const host = hostOf(request.url);
  const common = {
    sessionId: scope.sessionId,
    ...(request.toolCallId === undefined || request.toolCallId === ''
      ? {}
      : { toolCallId: request.toolCallId.slice(0, 256) }),
    tool: (request.toolName ?? request.toolKind ?? 'unknown').slice(0, 256) || 'unknown',
    ...(request.toolKind === undefined || request.toolKind === ''
      ? {}
      : { kind: request.toolKind.slice(0, 256) }),
    paths: paths.slice(0, PERMISSION_EVENT_MAX_PATHS),
    pathCount: paths.length,
    ...(host === undefined ? {} : { host }),
    playId: scope.playId,
    demandId: scope.demandId,
    attemptId: scope.attemptId,
  };
  return [
    buildDaemonEvent('permission.asked', common),
    buildDaemonEvent('permission.answered', {
      ...common,
      answer: outcome.answered,
      rule: outcome.rule,
      reason: outcome.reason,
      ...(outcome.overruledRule === undefined ? {} : { overruledRule: outcome.overruledRule }),
    }),
  ];
}

/**
 * Resolves the symbolic links of an absolute path, including the part that does not exist yet: the
 * deepest ancestor that exists is resolved and the rest is put back. So a file the client is about
 * to create under a link that points out of the worktree is seen where it would really land.
 * A path that cannot be resolved at all (nothing of it exists, a permission error) comes back as it
 * is; the lexical check of the core still holds.
 */
export function resolveExistingPath(absolute: string): string {
  const root = parse(absolute).root;
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      if (current === root || dirname(current) === current) return absolute;
      tail.unshift(basename(current));
      current = dirname(current);
    }
  }
}
