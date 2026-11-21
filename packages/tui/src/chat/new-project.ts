// SPDX-License-Identifier: MPL-2.0
import type { ChatServerMessage } from '@otheater/protocol';

/**
 * The part of `/new project <repo>` that belongs to the TUI (P22 of Phase 7, N208 item 1). The
 * daemon runs the command, but it does not know the folder the TUI was opened in: so a line with
 * no repository opens the prompt of the TUI instead of going to the daemon, and a relative one
 * goes as an absolute path.
 */

/** `/new project`, with the repository after it (empty when the line has none); `undefined` for any other line. */
export function newProjectLine(text: string): { readonly repo: string } | undefined {
  const found = /^\/new\s+project(?:\s+([\s\S]*))?$/.exec(text.trim());
  return found === null ? undefined : { repo: (found[1] ?? '').trim() };
}

/**
 * The id of the project scenario a `/new project` just opened, when `frame` is its result (the
 * daemon answers `data: { scenarioId, type: 'project' }`); `undefined` for any other frame.
 */
export function openedProjectOf(frame: ChatServerMessage): string | undefined {
  if (frame.type !== 'command_result') return undefined;
  const { result } = frame;
  if (result.command !== 'new' || result.status !== 'done') return undefined;
  const { data } = result;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { scenarioId, type } = data;
  return type === 'project' && typeof scenarioId === 'string' ? scenarioId : undefined;
}
