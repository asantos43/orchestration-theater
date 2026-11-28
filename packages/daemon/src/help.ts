// SPDX-License-Identifier: MPL-2.0
import type { TFunction } from 'i18next';

/**
 * The help of `ot` (N325, owner's choice of 2026-11-25: the style of git and gh, built from a table).
 * `ot --help` is short: one line per command, in groups, with the columns aligned. `ot <command>
 * --help` and `ot help <command>` show the usage, the actions and the options of one command. The
 * structure lives here; every text lives in the `help` block of the `cli` catalog. A test checks that
 * each command and each option the parser accepts is in this table, so the help cannot fall behind.
 */

/** The groups of `ot --help`, in order. [proposta] */
export const HELP_GROUPS = ['start', 'accounts', 'work', 'system'] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

/** An option as the parser declares it (`parseArgs`). */
export interface HelpOptionSpec {
  readonly type: 'string' | 'boolean';
  readonly short?: string;
}

/** One command of `ot` in the help. */
export interface HelpCommand {
  readonly name: string;
  readonly group: HelpGroup;
  /** The actions (`ot profile add`), in the order of the help; a key of the catalog each. */
  readonly actions?: readonly string[];
  /** The options of the command, by their long name, in the order of the help. */
  readonly options?: readonly string[];
  /** The command has notes (`help.commands.<name>.notes`): paragraphs split by a blank line. */
  readonly notes?: boolean;
}

/** Every command of `ot`, by group, in the order of the help. [proposta] The groups and the order. */
export const HELP_COMMANDS: readonly HelpCommand[] = [
  { name: 'init', group: 'start', options: ['no-tui'] },
  { name: 'tui', group: 'start' },
  {
    name: 'chat',
    group: 'start',
    options: ['repo', 'base', 'name', 'type', 'new-project', 'init'],
    notes: true,
  },
  { name: 'daemon', group: 'start' },
  {
    name: 'profile',
    group: 'accounts',
    actions: ['add', 'list', 'drain', 'remove', 'exec', 'shims sync', 'shims path'],
    options: [
      'kind',
      'provider',
      'api-key-env',
      'api-key-stdin',
      'accept-notice',
      'login',
      'no-login',
      'client',
      'all',
      'check-login',
      'json',
      'install',
      'uninstall',
      'shell',
      'yes',
    ],
    notes: true,
  },
  {
    name: 'executor',
    group: 'accounts',
    actions: ['models', 'add', 'list', 'check', 'remove'],
    options: [
      'effort',
      'family',
      'as',
      'local-url',
      'local-server',
      'role',
      'test-session',
      'no-test-session',
      'dry-run',
      'profile',
      'all',
      'json',
    ],
  },
  {
    name: 'adapters',
    group: 'accounts',
    actions: ['status', 'install'],
    options: ['json'],
    notes: true,
  },
  { name: 'vault', group: 'accounts', actions: ['status', 'use'], options: ['json'], notes: true },
  {
    name: 'directives',
    group: 'work',
    actions: ['list', 'show', 'add', 'extend', 'suspend', 'revoke'],
    options: [
      'scenario',
      'kind',
      'role',
      'rule-key',
      'rule-value',
      'suspends',
      'replaces',
      'from',
      'until',
      'for',
      'forever',
      'reason',
      'all',
    ],
  },
  {
    name: 'flow',
    group: 'work',
    actions: [
      'validate',
      'simulate',
      'save',
      'activate',
      'deactivate',
      'diff',
      'list',
      'install',
      'bind',
      'pause',
      'resume',
      'stop',
    ],
    options: [
      'workflow',
      'scenario',
      'state',
      'input',
      'outputs',
      'fail',
      'activate',
      'approve',
      'range',
      'params',
      'triggers',
      'until',
      'budget',
      'period',
      'concurrency',
      'on-busy',
      'json',
    ],
    notes: true,
  },
  {
    name: 'plugin',
    group: 'work',
    actions: ['install', 'list', 'update', 'remove', 'enable', 'disable', 'secret set'],
    options: ['project', 'yes', 'json'],
    notes: true,
  },
  { name: 'trajectory', group: 'work', actions: ['export'], options: ['unit', 'content', 'out'] },
  {
    name: 'analysis',
    group: 'work',
    options: [
      'from',
      'to',
      'group-by',
      'scenario',
      'compare-from',
      'compare-to',
      'compare-scenario',
      'json',
    ],
  },
  {
    name: 'service',
    group: 'system',
    actions: ['install', 'uninstall', 'status', 'start', 'stop'],
    options: ['no-start', 'json'],
    notes: true,
  },
  { name: 'uninstall', group: 'system', options: ['purge-data', 'yes'] },
  { name: 'backup', group: 'system' },
  { name: 'restore', group: 'system' },
  { name: 'api', group: 'system', actions: ['rotate-token'] },
];

/** The options of every command (`--data-dir`, `--help`...), in the order of the help. */
export const HELP_GLOBAL_OPTIONS = ['data-dir', 'non-interactive', 'help', 'version'] as const;

/** The command of the table, or `undefined`. */
export function helpCommandOf(name: string): HelpCommand | undefined {
  return HELP_COMMANDS.find((command) => command.name === name);
}

/** `ui.help_width` (N325): the width of the terminal capped for reading, the whole width, or a number. */
export type HelpWidthSetting = 'readable' | 'terminal' | number;

/** The cap of `readable`. [proposta] Like clap and most help pages, so a wide terminal still reads well. */
export const HELP_READABLE_WIDTH = 100;
/** The width when there is no terminal and no `COLUMNS`: the classic one. */
export const HELP_FALLBACK_WIDTH = 80;
/** Below this the columns do not fit: the help still draws, just at this width. */
export const HELP_MIN_WIDTH = 40;

/** The width the help is drawn at: the setting, the terminal (`columns`, then `COLUMNS`), 80 without one. */
export function helpWidth(
  setting: HelpWidthSetting,
  columns: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (typeof setting === 'number') return Math.max(HELP_MIN_WIDTH, setting);
  const fromEnv = Number.parseInt(env.COLUMNS ?? '', 10);
  const terminal =
    columns !== undefined && columns > 0
      ? columns
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : HELP_FALLBACK_WIDTH;
  const width = setting === 'readable' ? Math.min(terminal, HELP_READABLE_WIDTH) : terminal;
  return Math.max(HELP_MIN_WIDTH, width);
}

/** The words of `text` in lines of at most `width` characters (a longer word gets a line of its own). */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/u).filter((w) => w !== '')) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The indent of a section's rows, and the widest left column before the text goes below it. */
const INDENT = 2;
const GAP = 2;
/** [proposta] A left column wider than this puts its text on the next line, as gh does. */
const MAX_LEFT = 28;
/** Below this the text would be too narrow beside the left column: it goes below, indented. */
const MIN_TEXT = 24;

/**
 * Rows of two columns, aligned: the text starts at the same column on every row and wraps with a
 * hanging indent. A left part wider than {@link MAX_LEFT} puts its text on the next line.
 */
export function table(
  rows: readonly (readonly [string, string])[],
  width: number,
  /** The left column is at least this wide: the groups of `ot --help` share one column. */
  leftWidth = 0,
): string[] {
  const widest = Math.max(leftWidth, ...rows.map(([left]) => left.length));
  let column = INDENT + Math.min(widest, MAX_LEFT) + GAP;
  if (width - column < MIN_TEXT) column = INDENT * 3;
  const textWidth = Math.max(width - column, MIN_TEXT);
  const pad = ' '.repeat(column);
  const lines: string[] = [];
  for (const [left, text] of rows) {
    const head = `${' '.repeat(INDENT)}${left}`;
    const body = text === '' ? [] : wrap(text, textWidth);
    if (head.length + GAP <= column && body.length > 0) {
      lines.push(`${head.padEnd(column)}${body[0] ?? ''}`.trimEnd());
      for (const line of body.slice(1)) lines.push(`${pad}${line}`);
    } else {
      lines.push(head);
      for (const line of body) lines.push(`${pad}${line}`);
    }
  }
  return lines;
}

/** A paragraph wrapped at `width`, indented. */
function paragraph(text: string, width: number): string[] {
  return wrap(text, width - INDENT).map((line) =>
    line === '' ? '' : `${' '.repeat(INDENT)}${line}`,
  );
}

/** How an option is written: `-y, --yes`, `--repo <folder>`. */
function optionLabel(
  name: string,
  spec: HelpOptionSpec | undefined,
  value: string | undefined,
): string {
  const long = `--${name}`;
  const withValue = spec?.type === 'string' && value !== undefined ? `${long} ${value}` : long;
  return spec?.short === undefined ? withValue : `-${spec.short}, ${withValue}`;
}

function globalRows(
  t: TFunction,
  options: Readonly<Record<string, HelpOptionSpec>>,
): (readonly [string, string])[] {
  return HELP_GLOBAL_OPTIONS.map((name) => {
    const spec = options[name];
    const value = spec?.type === 'string' ? t(`help.global.${name}.value`) : undefined;
    return [optionLabel(name, spec, value), t(`help.global.${name}.summary`)] as const;
  });
}

/** `ot --help` and `ot help`: the commands by group, the global options and where to learn more. */
export function renderMainHelp(
  t: TFunction,
  options: Readonly<Record<string, HelpOptionSpec>>,
  width: number,
): string {
  const lines: string[] = [...wrap(t('help.about'), width), ''];
  lines.push(t('help.section.usage'), ...table([[t('help.mainUsage'), '']], width), '');
  const names = Math.max(...HELP_COMMANDS.map((command) => command.name.length));
  for (const group of HELP_GROUPS) {
    const rows = HELP_COMMANDS.filter((command) => command.group === group).map(
      (command) => [command.name, t(`help.commands.${command.name}.summary`)] as const,
    );
    lines.push(t(`help.group.${group}`), ...table(rows, width, names), '');
  }
  lines.push(t('help.section.globalOptions'), ...table(globalRows(t, options), width), '');
  lines.push(
    t('help.section.learnMore'),
    ...table(
      [
        [t('help.learnMore.commandHelp'), t('help.learnMore.commandHelpText')],
        [t('help.learnMore.bare'), t('help.learnMore.bareText')],
      ],
      width,
    ),
    '',
    ...wrap(t('help.exitCodes'), width),
  );
  return lines.join('\n');
}

/** `ot <command> --help` and `ot help <command>`: the usage, the actions, the options and the notes. */
export function renderCommandHelp(
  command: HelpCommand,
  t: TFunction,
  options: Readonly<Record<string, HelpOptionSpec>>,
  width: number,
  values: Readonly<Record<string, string>> = {},
): string {
  const key = `help.commands.${command.name}`;
  // The page opens with the long description (the daemon it needs, what it does); the list, the summary.
  const lines: string[] = [...wrap(t(`${key}.description`), width), ''];
  const usage = t(`${key}.usage`)
    .split('\n')
    .map((line) => [line, ''] as const);
  lines.push(t('help.section.usage'), ...table(usage, width), '');
  if (command.actions !== undefined && command.actions.length > 0) {
    const rows = command.actions.map((action) => {
      const args = t(`${key}.actions.${action}.args`, { defaultValue: '' });
      return [
        args === '' ? action : `${action} ${args}`,
        t(`${key}.actions.${action}.summary`),
      ] as const;
    });
    lines.push(t('help.section.actions'), ...table(rows, width), '');
  }
  if (command.options !== undefined && command.options.length > 0) {
    const rows = command.options.map((name) => {
      const spec = options[name];
      const value = spec?.type === 'string' ? t(`${key}.options.${name}.value`) : undefined;
      return [optionLabel(name, spec, value), t(`${key}.options.${name}.summary`)] as const;
    });
    lines.push(t('help.section.options'), ...table(rows, width), '');
  }
  if (command.notes === true) {
    lines.push(t('help.section.notes'), ...paragraph(t(`${key}.notes`, values), width), '');
  }
  lines.push(t('help.section.globalOptions'), ...table(globalRows(t, options), width));
  return lines.join('\n');
}
