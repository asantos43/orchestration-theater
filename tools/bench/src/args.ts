// SPDX-License-Identifier: MPL-2.0
import { parseArgs } from 'node:util';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export const SECTIONS = ['all', 'a', 'b'] as const;
export type Section = (typeof SECTIONS)[number];

export interface StoreArgs {
  readonly command: 'store';
  /** Folder for the databases; must be on a real disk. */
  readonly dir: string;
  readonly quick: boolean;
  readonly out: string | undefined;
  readonly section: Section;
  /** Overall time budget: scenarios that have not started when it runs out are skipped. */
  readonly budgetMinutes: number;
}

export type ParsedArgs = StoreArgs | { readonly command: 'help' };

export const USAGE = `Usage: node tools/bench/dist/cli.js store --dir <folder> [options]

Measures the cost of PRAGMA synchronous=FULL (A) and the backup methods (B) of the SQLite store.

Options:
  --dir <folder>        required; databases go in a temporary sub-folder, removed at the end.
                        Refused when the folder is on tmpfs/ramfs (fsync there means nothing).
  --quick               one repetition, shorter runs, only the 10 MB database (smoke test)
  --out <file.json>     write the full results as JSON (and a summary as <file>.md beside it)
  --section <a|b|all>   run only scenario A (synchronous) or B (backup); default all
  --budget-minutes <n>  stop starting new runs after n minutes (default 60)
  -h, --help            this text

Exit codes: 0 ok, 1 measurement failed, 2 usage error or unsafe folder.`;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        quick: { type: 'boolean', default: false },
        out: { type: 'string' },
        section: { type: 'string', default: 'all' },
        'budget-minutes': { type: 'string', default: '60' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) return { command: 'help' };
  const [command, ...extra] = positionals;
  if (command !== 'store') throw new UsageError(`Unknown command "${String(command)}"`);
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${String(extra[0])}"`);
  if (values.dir === undefined || values.dir === '') {
    throw new UsageError('--dir <folder> is required (a folder on a real disk, not tmpfs)');
  }
  const section = SECTIONS.find((name) => name === values.section);
  if (section === undefined) {
    throw new UsageError(`--section must be one of ${SECTIONS.join(', ')}`);
  }
  const budgetMinutes = Number(values['budget-minutes']);
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
    throw new UsageError('--budget-minutes must be a number > 0');
  }
  return {
    command: 'store',
    dir: values.dir,
    quick: values.quick,
    out: values.out,
    section,
    budgetMinutes,
  };
}
