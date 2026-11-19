// SPDX-License-Identifier: MPL-2.0
/**
 * The common commands and options of `ot profile exec` (Phase 5, P28a, N159): the same words for
 * every client (`login`, `logout`, `status`, `run`, `--model`), translated into the tokens of each
 * one. The adapter says how its client writes them (`ProfileCli.commands` and `.options`); the
 * configuration adds more, or rewrites one, by client (`profiles.commands.<name>.<client>`,
 * `profiles.options.<name>.<client>`), so a client other than the three also fits. [proposta]
 *
 * Owner's decisions (N159, 2026-11-19): when a common word is also a word of the client, the common
 * one wins, and the original is reached after `--` (`codex-personal -- login --device-auth`).
 */

/** The common commands every built-in adapter knows. */
export const COMMON_COMMANDS: readonly string[] = ['login', 'logout', 'status', 'run'];

/** The common options every built-in adapter knows; written `--<name> <value>` or `--<name>=<value>`. */
export const COMMON_OPTIONS: readonly string[] = ['model'];

/** What a common name may be: lower case, digits and `-`, starting with a letter. */
export const COMMON_NAME = /^[a-z][a-z0-9-]*$/;

/** How one client writes the common words: the name, then its own tokens. */
export interface CommonArgsMap {
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly options: Readonly<Record<string, readonly string[]>>;
}

/** What the configuration adds, by common name and then by client id. */
export interface CommonArgsOverrides {
  readonly commands: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly options: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/** Every common name, of any client: the built-in ones and the configured ones. */
export interface CommonNames {
  readonly commands: readonly string[];
  readonly options: readonly string[];
}

export type CommonArgsResult =
  | {
      readonly ok: true;
      /** The arguments for the client, after its `ProfileCli.args`. */
      readonly args: readonly string[];
      /** The common command that was translated, or `null` when the first word went as it was. */
      readonly command: string | null;
    }
  | {
      readonly ok: false;
      /** A common word this client has no translation for. */
      readonly reason: 'not_for_client';
      readonly kind: 'command' | 'option';
      readonly name: string;
      /** The common words this client does have, sorted. */
      readonly available: CommonNames;
    }
  | {
      readonly ok: false;
      /** A common option at the end, with no value. */
      readonly reason: 'missing_value';
      readonly name: string;
    };

/** The map of one client: the adapter's own, with the configuration over it. */
export function commonArgsFor(
  own: CommonArgsMap,
  client: string,
  overrides: CommonArgsOverrides,
): CommonArgsMap {
  const pick = (
    base: Readonly<Record<string, readonly string[]>>,
    extra: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
  ): Record<string, readonly string[]> => {
    const out: Record<string, readonly string[]> = { ...base };
    for (const [name, byClient] of Object.entries(extra)) {
      const tokens = byClient[client];
      if (tokens !== undefined) out[name] = [...tokens];
    }
    return out;
  };
  return {
    commands: pick(own.commands, overrides.commands),
    options: pick(own.options, overrides.options),
  };
}

/** The common names of every client: the built-in ones and those of the configuration. */
export function commonNames(overrides: CommonArgsOverrides): CommonNames {
  const merge = (base: readonly string[], extra: object): string[] =>
    [...new Set([...base, ...Object.keys(extra)])].sort();
  return {
    commands: merge(COMMON_COMMANDS, overrides.commands),
    options: merge(COMMON_OPTIONS, overrides.options),
  };
}

/**
 * Translates what the person typed after the name of the command (`codex-personal run "hi"`) into
 * the arguments of the client (`exec "hi"`). Pure.
 *
 * - `--` as the first argument: everything after it goes as it is, with no translation.
 * - Common options at the start (`--model x`), then a common command: the command goes first and
 *   the options after it (`codex exec --model x`), since most clients read the options of their
 *   subcommand there. With no common command, they stay where they were.
 * - A common option later on is translated too, up to a `--`, which goes to the client with what
 *   comes after it.
 * - A common word this client has no translation for is an error, never passed on as it was: the
 *   person meant the common one. A word that is not common goes as it is.
 */
export function translateCommonArgs(
  args: readonly string[],
  map: CommonArgsMap,
  names: CommonNames,
): CommonArgsResult {
  if (args[0] === '--') return { ok: true, args: args.slice(1), command: null };
  const available = (): CommonNames => ({
    commands: Object.keys(map.commands).sort(),
    options: Object.keys(map.options).sort(),
  });
  // Reads one common option at `at`; `undefined` when the token is not one.
  const optionAt = (
    at: number,
  ): { tokens: string[]; next: number } | Extract<CommonArgsResult, { ok: false }> | undefined => {
    const token = args[at];
    if (token === undefined || !token.startsWith('--') || token === '--') return undefined;
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (!names.options.includes(name)) return undefined;
    const own = map.options[name];
    if (own === undefined) {
      return { ok: false, reason: 'not_for_client', kind: 'option', name, available: available() };
    }
    if (equals !== -1) return { tokens: [...own, token.slice(equals + 1)], next: at + 1 };
    const value = args[at + 1];
    if (value === undefined) return { ok: false, reason: 'missing_value', name };
    return { tokens: [...own, value], next: at + 2 };
  };

  let at = 0;
  const leading: string[] = [];
  for (;;) {
    const option = optionAt(at);
    if (option === undefined) break;
    if ('ok' in option) return option;
    leading.push(...option.tokens);
    at = option.next;
  }

  let command: string | null = null;
  const head: string[] = [];
  const first = args[at];
  if (first !== undefined && names.commands.includes(first)) {
    const own = map.commands[first];
    if (own === undefined) {
      return {
        ok: false,
        reason: 'not_for_client',
        kind: 'command',
        name: first,
        available: available(),
      };
    }
    command = first;
    head.push(...own);
    at += 1;
  }

  const rest: string[] = [];
  for (let token = args[at]; token !== undefined; token = args[at]) {
    if (token === '--') {
      rest.push(...args.slice(at));
      break;
    }
    const option = optionAt(at);
    if (option === undefined) {
      rest.push(token);
      at += 1;
      continue;
    }
    if ('ok' in option) return option;
    rest.push(...option.tokens);
    at = option.next;
  }
  return { ok: true, args: [...head, ...leading, ...rest], command };
}
