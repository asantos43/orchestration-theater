// SPDX-License-Identifier: MPL-2.0

/** A line of the Producer that starts with a slash, split in the name and the rest. */
export interface SlashLine {
  /** The name as typed, without the slash: `status`, `claude:compact`. */
  readonly name: string;
  /** What follows the name, trimmed; empty when nothing does. */
  readonly text: string;
}

const LINE = /^\/([A-Za-z][A-Za-z0-9_.:-]*)(?:\s+([\s\S]*))?$/;

/**
 * Parses `/name rest of the line`. `undefined` when the line is not a command: it does not start
 * with a slash, or what follows the slash is not a name (`/ foo`, `//`, `/1`).
 */
export function parseSlashLine(line: string): SlashLine | undefined {
  const match = LINE.exec(line.trim());
  if (match === null) return undefined;
  return { name: match[1] ?? '', text: (match[2] ?? '').trim() };
}

/** The prefix of the commands of a client, as the Producer types it (`claude` for `claude-code`). */
export function clientPrefixOf(client: string): string {
  return client === 'claude-code' ? 'claude' : client;
}

/** A name of the allow list without its slash, so `/claude:compact` and `claude:compact` are one. */
export function bareCommandName(name: string): string {
  return name.replace(/^\//, '');
}
