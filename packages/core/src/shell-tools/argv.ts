// SPDX-License-Identifier: MPL-2.0
import { ShellToolRefusal } from './refusal.js';

/**
 * [proposta] Rules of the `argv` a shell tool runs (architecture 5.8, N97). The command is a list,
 * never a string: nothing goes through a shell, so there is no `;`, `|`, `&&`, `||`, redirection,
 * backtick, `$()` or expansion to honour. The checks here refuse them anyway, with a clear reason,
 * so the model learns at once that it asked for something the tool does not do, and a later change
 * that put a shell in the middle would not open a hole.
 */

/** The program is a bare name looked up on the `PATH`: no `/`, no `\`, no `~`, no leading `-`. */
const BARE_PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

/** An argument that is only a shell control operator or a redirection (`;`, `&&`, `2>`, `>>`...). */
const OPERATOR_ARG = /^(?:[;&|]+|&>>?|\d*(?:>>?|<<?<?)&?\d*)$/;

/** A redirection glued to its target (`>out.txt`, `2>/dev/null`, `<in`). */
const REDIRECT_PREFIX = /^\d*(?:>>?|<<?<?|>&|<&)/;

/** Command substitution and parameter expansion, with or without braces. */
const EXPANSION = /`|\$\(|\$\{|\$[A-Za-z_?!#@*$0-9]/;

/**
 * A control operator inside one argument, with or without blanks around it (`ls ; rm x`, `a && b`,
 * `true;touch x`, `a|b`, `a&b`). Any `;`, `&` or `|` counts: `&&`, `||` and `|&` are made of them.
 * Decided by the owner on 2026-11-17 ("recusar no validateArgv"): until then only an operator with a
 * blank on each side was refused, so `sh -c 'true;touch x'` went through in `shell_allowlist.mode:
 * any` (the sandbox, layer 3, was the only thing left to hold it). The price: a `;`, `&` or `|`
 * that is plain text also stops (`git log --format=%h|%s`, a URL with `?a=1&b=2`); say it without
 * the character (`%x7c`, `--data-urlencode`, `-e a -e b`).
 */
const EMBEDDED_OPERATOR = /[;&|]/;

/**
 * Programs whose arguments are patterns, never code, so an embedded operator is plain text there:
 * `rg 'a|b'` is a regex alternation, not a pipe. `rg` can run another program only through `--pre`
 * and `--pre-glob`, both refused by {@link assertNoForbiddenFlags} in every mode. Kept as short as
 * it is: `git` (aliases, `-c`), `node -e`, `sh -c`, `env`, `xargs` read their arguments as code.
 */
const PATTERN_PROGRAMS: ReadonlySet<string> = new Set(['rg']);

/** Longest argument and longest list accepted; a bound against absurd input. */
export const ARGV_MAX_ITEMS = 256;
export const ARGV_MAX_ITEM_LENGTH = 8192;

/**
 * Checks the shape of an argv and refuses shell syntax. Throws {@link ShellToolRefusal}. Does not
 * look at the allowlist or at paths (see {@link matchAllowlist} and `confineArgv`).
 */
export function validateArgv(argv: readonly string[]): void {
  if (argv.length === 0) throw new ShellToolRefusal('empty_argv', 'argv must not be empty');
  if (argv.length > ARGV_MAX_ITEMS) {
    throw new ShellToolRefusal(
      'invalid_argument',
      `argv has more than ${String(ARGV_MAX_ITEMS)} items`,
    );
  }
  for (const item of argv) {
    if (item.includes('\0')) {
      throw new ShellToolRefusal('invalid_argument', 'an argv item must not contain NUL');
    }
    if (item.length > ARGV_MAX_ITEM_LENGTH) {
      throw new ShellToolRefusal(
        'invalid_argument',
        `an argv item is longer than ${String(ARGV_MAX_ITEM_LENGTH)} characters`,
      );
    }
  }
  const program = argv[0] ?? '';
  if (!BARE_PROGRAM.test(program)) {
    throw new ShellToolRefusal(
      'program_by_path',
      `the program must be a plain name from the allowlist, not a path or an expression: ${JSON.stringify(program)}`,
    );
  }
  const patternProgram = PATTERN_PROGRAMS.has(program);
  for (const arg of argv.slice(1)) {
    if (OPERATOR_ARG.test(arg) || REDIRECT_PREFIX.test(arg)) {
      throw new ShellToolRefusal(
        'shell_syntax',
        `there is no shell here: chaining and redirection are not available (${JSON.stringify(arg)})`,
      );
    }
    if (EXPANSION.test(arg) || (!patternProgram && EMBEDDED_OPERATOR.test(arg))) {
      throw new ShellToolRefusal(
        'shell_syntax',
        `there is no shell here: expansion and chaining inside an argument are not available (${JSON.stringify(arg)})`,
      );
    }
  }
}

/**
 * Splits one allowlist entry (`"git status"`, `"pnpm run"`, `"ls"`) into its words. An entry is a
 * program plus, optionally, the first words of the arguments that are allowed: `pnpm run` lets
 * `pnpm run build` through and refuses `pnpm add`.
 */
export function parseAllowEntry(entry: string): readonly string[] {
  const words = entry
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const program = words[0];
  if (program === undefined || !BARE_PROGRAM.test(program)) {
    throw new ShellToolRefusal(
      'program_by_path',
      `an allowlist entry must start with a plain program name: ${JSON.stringify(entry)}`,
    );
  }
  return words;
}

/** True when the argv starts with the words of at least one allowlist entry. */
export function matchAllowlist(argv: readonly string[], entries: readonly string[]): boolean {
  for (const entry of entries) {
    let words: readonly string[];
    try {
      words = parseAllowEntry(entry);
    } catch {
      continue;
    }
    if (words.length <= argv.length && words.every((word, i) => argv[i] === word)) return true;
  }
  return false;
}

/**
 * True when the argv starts with the words of at least one of the given commands. The mode
 * `profile` (N97) uses it with the commands of the project conventions, already split into argv.
 */
export function matchCommandPrefixes(
  argv: readonly string[],
  prefixes: readonly (readonly string[])[],
): boolean {
  return prefixes.some(
    (words) =>
      words.length > 0 && words.length <= argv.length && words.every((word, i) => argv[i] === word),
  );
}

/**
 * Flags that turn an otherwise read-only (or contained) program into a writer or a launcher of
 * another program: `git diff --output=file`, `rg --pre=cmd`. Refused in every mode, `any` included.
 */
const FORBIDDEN_FLAGS: Readonly<Record<string, readonly RegExp[]>> = {
  git: [/^--output(?:=|$)/, /^--ext-diff$/, /^--open-files-in-pager(?:=|$)/, /^--exec-path(?:=|$)/],
  rg: [/^--pre(?:=|$)/, /^--pre-glob(?:=|$)/],
};

/** `shell.node_inline` (N290): `deny` refuses the flags of {@link NODE_INLINE_LONG}; `allow` lets them run. */
export type NodeInlineMode = 'deny' | 'allow';

/**
 * Long flags of `node` that run code the argv does not show (N290, owner, 2026-11-23): the code of the
 * flag itself (`--eval`, `--print`), a module loaded before the script (`--require`, `--import`) and a
 * module of loader hooks (`--loader`, `--experimental-loader`), which is code too. `--input-type`
 * only has a meaning for `--eval` or for the standard input, so it goes with them. Node reads `_` as
 * `-` in a flag name, so both spellings are checked.
 */
const NODE_INLINE_LONG: ReadonlySet<string> = new Set([
  '--eval',
  '--print',
  '--require',
  '--import',
  '--input-type',
  '--loader',
  '--experimental-loader',
]);

/** A short flag of `node` that takes code or a module: `-e`, `-p`, `-r`, in a cluster (`-pe`) or with the value glued on (`-e"1+1"`, `-rmod`). */
const NODE_INLINE_SHORT = /^-[epr]/;

function isNodeInlineFlag(arg: string): boolean {
  if (arg.startsWith('--')) {
    const equals = arg.indexOf('=');
    const name = (equals < 0 ? arg : arg.slice(0, equals)).replaceAll('_', '-');
    return NODE_INLINE_LONG.has(name);
  }
  return NODE_INLINE_SHORT.test(arg);
}

export interface ForbiddenFlagsOptions {
  /** `shell.node_inline`; `deny` when left out. */
  readonly nodeInline?: NodeInlineMode;
}

/**
 * Throws `forbidden_flag` when the argv carries a flag of {@link FORBIDDEN_FLAGS} or, with
 * `nodeInline: 'deny'` (the default), a flag of `node` that runs code written in the argv itself.
 * The arguments of `node` are read up to the first `--`: the ones after it belong to the script, so
 * `node -- script.js -p` is fine and `node script.js -p` is refused (node cannot be asked where the
 * script starts without knowing every option that takes a separate value).
 */
export function assertNoForbiddenFlags(
  argv: readonly string[],
  options: ForbiddenFlagsOptions = {},
): void {
  const program = argv[0] ?? '';
  if (program === 'node' && (options.nodeInline ?? 'deny') === 'deny') {
    for (const arg of argv.slice(1)) {
      if (arg === '--') break;
      if (isNodeInlineFlag(arg)) {
        throw new ShellToolRefusal(
          'forbidden_flag',
          `the flag ${arg} is not allowed with node (shell.node_inline: deny): it runs code that is not in a file`,
        );
      }
    }
  }
  const patterns = FORBIDDEN_FLAGS[program];
  if (patterns === undefined) return;
  for (const arg of argv.slice(1)) {
    if (arg === '--') return;
    if (patterns.some((pattern) => pattern.test(arg))) {
      throw new ShellToolRefusal(
        'forbidden_flag',
        `the flag ${arg} is not allowed with ${program}`,
      );
    }
  }
}

/**
 * [proposta] The curated list of `tools.shell_allowlist.list` (N97): development tools, `git` only
 * in the subcommands that read. A `git` commit goes through the `git_commit` tool, which carries
 * the idempotency key and the verifier. The owner may replace the list in the configuration.
 */
export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch --list',
  'git rev-parse',
  'git ls-files',
  'git blame',
  'git describe',
  'git shortlog',
  'git ls-tree',
  'git cat-file',
  'ls',
  'cat',
  'head',
  'rg',
  'node',
  'pnpm run',
  'npm run',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
];

/**
 * Splits a command written as one string (`"pnpm test --run"`) into an argv, with no shell: words
 * are separated by blanks, and a pair of single or double quotes keeps blanks inside one word. A
 * backslash is an ordinary character. Throws on an unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const ch of line) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote !== undefined) {
    throw new ShellToolRefusal('invalid_argument', `unclosed quote in the command: ${line}`);
  }
  if (started) words.push(current);
  return words;
}
