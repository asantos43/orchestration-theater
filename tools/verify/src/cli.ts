#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COMMANDS, defaultContext, runCommand, type CommandName } from './commands.js';
import { UsageError } from './common.js';

const USAGE = `Usage: node tools/verify/dist/cli.js <command> [options]

Commands:
  licenses [--json <file>]   check the licenses of the installed pnpm tree
  notices [--check]          generate THIRD_PARTY_NOTICES.md (--check: fail if it is out of date)
  headers                    check SPDX headers of tracked source files
  credentials                forbid credential file names and endpoints (architecture 6.3)
  catalogs                   compare the i18n catalogs of all languages
  deps                       check the dependency rule with dependency-cruiser

Options:
  --root <dir>               repository root (default: derived from this file's location)

Exit codes: 0 ok, 1 verification failed, 2 usage or environment error.`;

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'string' },
        check: { type: 'boolean', default: false },
        root: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const name = positionals[0];
  if (name === undefined || positionals.length > 1 || !isCommand(name)) {
    throw new UsageError(`expected exactly one command: ${COMMANDS.join(', ')} (see --help)`);
  }
  if (values.check && name !== 'notices') throw new UsageError('--check only applies to "notices"');
  if (values.json !== undefined && name !== 'licenses')
    throw new UsageError('--json only applies to "licenses"');
  const root = path.resolve(values.root ?? path.join(import.meta.dirname, '..', '..', '..'));
  return runCommand(name, defaultContext(root), { json: values.json, check: values.check });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 2;
  },
);
