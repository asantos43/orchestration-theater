// SPDX-License-Identifier: MPL-2.0
import type { ApiSlashCommand } from '@otheater/protocol';

/**
 * The / commands that fit what the Producer typed so far (P12 of docs/18). The list itself comes
 * from `GET /v1/commands`; this is only the filter and what Enter completes to.
 */

/** Whether the text is a command name still being typed: `/`, then no space and no new line. */
export function typingCommandName(text: string): boolean {
  return /^\/[^\s]*$/u.test(text);
}

/** The commands whose name starts with the text, at most `limit`, in the order the daemon gave. */
export function suggestionsFor(
  commands: readonly ApiSlashCommand[],
  text: string,
  limit: number,
): ApiSlashCommand[] {
  if (limit <= 0 || !typingCommandName(text)) return [];
  const prefix = text.toLowerCase();
  const found = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
  // Nothing left to complete: the text is the name, so Enter sends it.
  if (found.length === 1 && found[0]?.name.toLowerCase() === prefix) return [];
  return found.slice(0, limit);
}

/** What Enter writes in the box for a command: its name and a space for the arguments. */
export function completionOf(command: ApiSlashCommand): string {
  return `${command.name} `;
}
