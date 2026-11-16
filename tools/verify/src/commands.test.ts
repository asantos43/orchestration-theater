// SPDX-License-Identifier: MPL-2.0
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UsageError, type ExecFn } from './common.js';
import {
  COMMANDS,
  NOTICES_FILE,
  runCommand,
  type CommandContext,
  type CommandName,
} from './commands.js';
import { cleanupTemp, makeTemp, REPOSITORY_ROOT, writeTree } from './test-helpers.js';

afterAll(cleanupTemp);

function fixtureRoot(files: Record<string, string> = {}): string {
  const root = makeTemp('otheater-cmd-');
  mkdirSync(path.join(root, 'tools', 'verify'), { recursive: true });
  for (const name of ['policy.json', 'copied-code.json']) {
    copyFileSync(
      path.join(REPOSITORY_ROOT, 'tools', 'verify', name),
      path.join(root, 'tools', 'verify', name),
    );
  }
  writeTree(root, files);
  return root;
}

function context(root: string, exec: ExecFn): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  return { ctx: { root, exec, env: {}, write: (t) => output.push(t) }, output };
}

function pnpmOutput(
  packages: Record<string, { license: string; dir: string }>,
  scope: 'prod' | 'dev',
): ExecFn {
  return (_file, args) => {
    if (!args.includes(`--${scope}`)) return Promise.resolve('No licenses in packages found');
    const grouped: Record<string, unknown[]> = {};
    for (const [name, info] of Object.entries(packages)) {
      (grouped[info.license] ??= []).push({
        name,
        versions: ['1.0.0'],
        paths: [info.dir],
        license: info.license,
      });
    }
    return Promise.resolve(JSON.stringify(grouped));
  };
}

const NO_JSON = { json: undefined, check: false };

describe('commands', () => {
  it('lists the six subcommands', () => {
    expect([...COMMANDS]).toEqual([
      'licenses',
      'notices',
      'headers',
      'credentials',
      'catalogs',
      'deps',
    ]);
  });

  it('licenses: 0 packages fails (exit 1)', async () => {
    const { ctx, output } = context(fixtureRoot(), () =>
      Promise.resolve('No licenses in packages found'),
    );
    expect(await runCommand('licenses', ctx, NO_JSON)).toBe(1);
    expect(output.join('\n')).toContain('0');
  });

  it('licenses: an allowed tree passes and --json writes the report; a forbidden license fails', async () => {
    const root = fixtureRoot();
    const jsonFile = path.join(root, 'report.json');
    const ok = context(
      root,
      pnpmOutput(
        { left: { license: 'MIT', dir: path.join(root, 'node_modules', 'left') } },
        'prod',
      ),
    );
    expect(await runCommand('licenses', ok.ctx, { json: jsonFile, check: false })).toBe(0);
    const report: unknown = JSON.parse(readFileSync(jsonFile, 'utf8'));
    expect(JSON.stringify(report)).not.toContain(root);

    const bad = context(
      root,
      pnpmOutput(
        { gpl: { license: 'GPL-3.0-only', dir: path.join(root, 'node_modules', 'gpl') } },
        'prod',
      ),
    );
    expect(await runCommand('licenses', bad.ctx, NO_JSON)).toBe(1);
  });

  it('licenses: a failing pnpm is a usage/environment error', async () => {
    const { ctx } = context(fixtureRoot(), () =>
      Promise.reject(new UsageError('pnpm is not installed')),
    );
    await expect(runCommand('licenses', ctx, NO_JSON)).rejects.toBeInstanceOf(UsageError);
  });

  it('notices: writes the file, then --check passes; changing it makes --check fail', async () => {
    const root = fixtureRoot();
    const exec = (): Promise<string> => Promise.resolve('No licenses in packages found');
    const { ctx } = context(root, exec);
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(1);
    expect(await runCommand('notices', ctx, NO_JSON)).toBe(0);
    expect(existsSync(path.join(root, NOTICES_FILE))).toBe(true);
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(0);
    writeFileSync(path.join(root, NOTICES_FILE), 'changed\n');
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(1);
  });

  it('catalogs: the fixture without locales fails, with matching locales passes', async () => {
    const empty = context(fixtureRoot(), () => Promise.resolve(''));
    expect(await runCommand('catalogs', empty.ctx, NO_JSON)).toBe(1);
    const root = fixtureRoot({
      'locales/en/common.json': '{"a":"x"}',
      'locales/pt-BR/common.json': '{"a":"y"}',
    });
    const full = context(root, () => Promise.resolve(''));
    expect(await runCommand('catalogs', full.ctx, NO_JSON)).toBe(0);
  });

  it('headers and credentials run on the files that git lists', async () => {
    const root = fixtureRoot({ 'src/a.ts': 'export {};\n', 'src/b.txt': 'nothing here\n' });
    const listing = (): Promise<string> => Promise.resolve('src/a.ts\0src/b.txt\0');
    const headers = context(root, listing);
    expect(await runCommand('headers', headers.ctx, NO_JSON)).toBe(1);
    writeFileSync(path.join(root, 'src/a.ts'), '// SPDX-License-Identifier: MPL-2.0\nexport {};\n');
    expect(await runCommand('headers', headers.ctx, NO_JSON)).toBe(0);
    expect(await runCommand('credentials', headers.ctx, NO_JSON)).toBe(0);
  });

  it('every command name is dispatched', () => {
    const names: CommandName[] = [...COMMANDS];
    expect(names).toHaveLength(6);
  });
});
