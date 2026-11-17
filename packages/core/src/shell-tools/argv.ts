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

/** A control operator between two words inside one argument (`ls ; rm x`, `a && b`, `a | b`). */
const EMBEDDED_OPERATOR = /\s(?:;|&&|\|\||\||&)\s/;

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
  for (const arg of argv.slice(1)) {
    if (OPERATOR_ARG.test(arg) || REDIRECT_PREFIX.test(arg)) {
      throw new ShellToolRefusal(
        'shell_syntax',
        `there is no shell here: chaining and redirection are not available (${JSON.stringify(arg)})`,
      );
    }
    if (EXPANSION.test(arg) || EMBEDDED_OPERATOR.test(arg)) {
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
 * Flags that turn an otherwise read-only (or contained) program into a writer or a launcher of
 * another program: `git diff --output=file`, `rg --pre=cmd`. Refused in every mode, `any` included.
 */
const FORBIDDEN_FLAGS: Readonly<Record<string, readonly RegExp[]>> = {
  git: [/^--output(?:=|$)/, /^--ext-diff$/, /^--open-files-in-pager(?:=|$)/, /^--exec-path(?:=|$)/],
  rg: [/^--pre(?:=|$)/, /^--pre-glob(?:=|$)/],
};

/** Throws `forbidden_flag` when the argv carries a flag of {@link FORBIDDEN_FLAGS}. */
export function assertNoForbiddenFlags(argv: readonly string[]): void {
  const patterns = FORBIDDEN_FLAGS[argv[0] ?? ''];
  if (patterns === undefined) return;
  for (const arg of argv.slice(1)) {
    if (arg === '--') return;
    if (patterns.some((pattern) => pattern.test(arg))) {
      throw new ShellToolRefusal(
        'forbidden_flag',
        `the flag ${arg} is not allowed with ${argv[0] ?? ''}`,
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
