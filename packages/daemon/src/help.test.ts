// SPDX-License-Identifier: MPL-2.0
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { CLI_OPTIONS, COMMANDS } from './cli.js';
import { ADAPTERS_ACTIONS } from './commands/adapters.js';
import { SERVICE_ACTIONS } from './commands/service.js';
import { VAULT_ACTIONS } from './commands/vault.js';
import { TRAJECTORY_ACTIONS } from './atif/command.js';
import { DIRECTIVE_ACTIONS } from './directives/command.js';
import { FLOW_ACTIONS } from './commands/flow.js';
import { EXECUTOR_ACTIONS } from './executors/command.js';
import { PLUGIN_ACTIONS } from './plugins/command.js';
import { PROFILE_ACTIONS } from './profiles/command.js';
import { SHIMS_ACTIONS } from './profiles/shims-command.js';
import {
  HELP_COMMANDS,
  HELP_GLOBAL_OPTIONS,
  helpCommandOf,
  helpWidth,
  renderCommandHelp,
  renderMainHelp,
  table,
  wrap,
} from './help.js';
import { createTranslator, LOCALES } from './i18n.js';

/** The actions each command takes, as the parser knows them (`exec` and `shims` live in cli.ts). */
const PARSER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  profile: [...PROFILE_ACTIONS, 'exec', ...SHIMS_ACTIONS.map((action) => `shims ${action}`)],
  executor: EXECUTOR_ACTIONS,
  directives: DIRECTIVE_ACTIONS,
  plugin: PLUGIN_ACTIONS,
  service: SERVICE_ACTIONS,
  adapters: ADAPTERS_ACTIONS,
  vault: VAULT_ACTIONS,
  flow: FLOW_ACTIONS,
  trajectory: TRAJECTORY_ACTIONS,
  api: ['rotate-token'],
};

/** The lines of a section (`Options:`), up to the blank line that closes it. */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(title);
  if (start < 0) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The column where the text of each row starts (the rows whose left part fits beside it). */
function textColumns(rows: readonly string[]): number[] {
  return rows
    .map((row) => /^ {2}\S.*?\S? {2,}(?=\S)/u.exec(row)?.[0].length)
    .filter((column): column is number => column !== undefined);
}

const translators = async (): Promise<[string, TFunction][]> =>
  Promise.all(
    LOCALES.map(async (locale) => [locale, await createTranslator(locale)] as const),
  ).then((pairs) => pairs.map(([locale, t]) => [locale, t]));

describe('the help of ot (N325)', () => {
  it('has every command of the parser, once, and no other', () => {
    const names = HELP_COMMANDS.map((command) => command.name);
    expect([...names].sort()).toEqual([...COMMANDS].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('has every action of the parser, and no action the parser refuses', () => {
    for (const command of HELP_COMMANDS) {
      const parser = PARSER_ACTIONS[command.name] ?? [];
      const help = command.actions ?? [];
      // `secret` takes `set`: the help shows the whole words.
      const covered = (action: string): boolean =>
        help.some((shown) => shown === action || shown.startsWith(`${action} `));
      expect(
        parser.filter((action) => !covered(action)),
        command.name,
      ).toEqual([]);
      const known = (shown: string): boolean =>
        parser.some((action) => shown === action || shown.startsWith(`${action} `));
      expect(
        help.filter((shown) => !known(shown)),
        command.name,
      ).toEqual([]);
    }
  });

  it('shows every option of the parser, in some command or among the global ones', () => {
    const shown = new Set<string>([
      ...HELP_GLOBAL_OPTIONS,
      ...HELP_COMMANDS.flatMap((command) => command.options ?? []),
    ]);
    expect([...shown].sort()).toEqual(Object.keys(CLI_OPTIONS).sort());
  });

  it('has a text for every summary, action and option, in every language', async () => {
    for (const [locale, t] of await translators()) {
      const keys: string[] = ['help.about', 'help.mainUsage', 'help.exitCodes'];
      for (const name of HELP_GLOBAL_OPTIONS) keys.push(`help.global.${name}.summary`);
      for (const command of HELP_COMMANDS) {
        const base = `help.commands.${command.name}`;
        keys.push(`${base}.summary`, `${base}.description`, `${base}.usage`);
        if (command.notes === true) keys.push(`${base}.notes`);
        for (const action of command.actions ?? []) keys.push(`${base}.actions.${action}.summary`);
        for (const name of command.options ?? []) {
          keys.push(`${base}.options.${name}.summary`);
          if (CLI_OPTIONS[name as keyof typeof CLI_OPTIONS].type === 'string')
            keys.push(`${base}.options.${name}.value`);
        }
      }
      const missing = keys.filter((key) => t(key) === key || t(key) === '');
      expect(missing, locale).toEqual([]);
    }
  });

  it('aligns the text of each section at one column and keeps every line inside the width', async () => {
    for (const [locale, t] of await translators()) {
      for (const width of [60, 80, 100]) {
        const pages = [
          renderMainHelp(t, CLI_OPTIONS, width),
          ...HELP_COMMANDS.map((command) => renderCommandHelp(command, t, CLI_OPTIONS, width)),
        ];
        for (const page of pages) {
          for (const line of page.split('\n'))
            expect(line.length, `${locale} ${String(width)}: ${line}`).toBeLessThanOrEqual(width);
          for (const title of ['Actions:', 'Options:', 'Ações:', 'Opções:']) {
            const columns = textColumns(section(page, title));
            expect(
              new Set(columns).size,
              `${locale} ${String(width)} ${title}`,
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('puts the commands of every group of ot --help at one column', async () => {
    const t = await createTranslator('en');
    const page = renderMainHelp(t, CLI_OPTIONS, 100);
    const rows = HELP_COMMANDS.map(
      (command) => page.split('\n').find((line) => line.startsWith(`  ${command.name} `)) ?? '',
    );
    expect(new Set(textColumns(rows)).size).toBe(1);
    expect(page).toMatch(/^Usage:\n {2}ot <command> \[action\] \[options\]$/m);
    expect(page).toMatch(/^ {2}restore {2,}Put a backup back$/m);
  });

  it('names the valid clients in the help of ot profile', async () => {
    const t = await createTranslator('en');
    const profile = helpCommandOf('profile');
    if (profile === undefined) throw new Error('no profile in the help');
    const page = renderCommandHelp(profile, t, CLI_OPTIONS, 100, {
      clients: 'claude-code, codex, opencode',
    });
    expect(page).toContain('The clients: claude-code, codex, opencode.');
    expect(page).toMatch(/^ {2}add <client> <name> {2,}Add an account of a client$/m);
    expect(page).toMatch(/^ {2}-y, --yes {2,}shims path --install: do not ask$/m);
  });

  it('wraps with a hanging indent, and puts the text below a left part that is too wide', () => {
    const lines = table(
      [
        ['short', 'one two three four five six seven eight nine ten'],
        ['a-left-part-wider-than-the-limit-of-the-column', 'below'],
      ],
      60,
    );
    // The widest left part counts up to 28: the text starts at column 2 + 28 + 2.
    const pad = ' '.repeat(32);
    expect(lines).toEqual([
      `${'  short'.padEnd(32)}one two three four five six`,
      `${pad}seven eight nine ten`,
      '  a-left-part-wider-than-the-limit-of-the-column',
      `${pad}below`,
    ]);
    // Too narrow for the two columns: the text goes below every left part.
    expect(table([['short', 'one two']], 40, 40)).toEqual(['  short', '      one two']);
    expect(wrap('a b\n\nc', 10)).toEqual(['a b', '', 'c']);
  });

  it('draws at the setting, the terminal capped at 100, COLUMNS, or 80', () => {
    expect(helpWidth('readable', 200, {})).toBe(100);
    expect(helpWidth('terminal', 200, {})).toBe(200);
    expect(helpWidth('readable', undefined, { COLUMNS: '72' })).toBe(72);
    expect(helpWidth('readable', undefined, {})).toBe(80);
    expect(helpWidth(120, 60, {})).toBe(120);
    expect(helpWidth('terminal', 20, {})).toBe(40);
  });
});
