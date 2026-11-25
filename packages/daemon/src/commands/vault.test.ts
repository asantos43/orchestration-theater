// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { dataPaths } from '../paths.js';

/**
 * `ot vault status|use` (Phase 11b, N322): the installers write the choice of the vault through it.
 * Temporary data folder only; no vault is opened (the command edits `config.yaml` and nothing else).
 */

let root: string;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-vault-'));
  data = join(root, 'data');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}
async function ot(argv: readonly string[], locale = 'en'): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: { PATH: '/nowhere' },
    platform: 'linux',
    homedir: join(root, 'home'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: locale,
    version: '0.0.0-test',
  });
  return { code, out, err };
}
const config = (): Promise<string> => readFile(dataPaths(data).config, 'utf8');

describe('ot vault (N322)', () => {
  it('status says the default, keyring, with no config file', async () => {
    const run = await ot(['vault', 'status']);
    expect(run.code, run.err.join('\n')).toBe(0);
    expect(run.out.join('\n')).toContain('(adapters.vault) is keyring');
    const json = await ot(['vault', 'status', '--json']);
    expect(JSON.parse(json.out.join(''))).toEqual({ vault: 'keyring' });
  });

  it('use writes adapters.vault and keeps the comments and the other keys', async () => {
    await mkdir(data, { recursive: true });
    await writeFile(
      dataPaths(data).config,
      '# my config\nbackup:\n  when: manual # by hand\nadapters:\n  store: sqlite\n',
    );
    const run = await ot(['vault', 'use', 'encrypted-file']);
    expect(run.code, run.err.join('\n')).toBe(0);
    expect(run.out.join('\n')).toContain('now encrypted-file (it was keyring)');
    const text = await config();
    expect(text).toContain('# my config');
    expect(text).toContain('when: manual # by hand');
    expect(text).toContain('store: sqlite');
    expect(text).toContain('vault: encrypted-file');
    expect((await ot(['vault', 'status', '--json'])).out.join('')).toBe(
      '{"vault":"encrypted-file"}',
    );

    const again = await ot(['vault', 'use', 'encrypted-file']);
    expect(again.code).toBe(0);
    expect(again.out.join('\n')).toContain('already encrypted-file');
  });

  it('use creates the config file when there is none, and speaks pt-BR', async () => {
    const run = await ot(['vault', 'use', 'auto'], 'pt-BR');
    expect(run.code, run.err.join('\n')).toBe(0);
    expect(run.out.join('\n')).toContain('agora é auto (era keyring)');
    expect(await config()).toContain('vault: auto');
  });

  it('a config that is not valid YAML is left as it is and the command fails', async () => {
    await mkdir(data, { recursive: true });
    await writeFile(dataPaths(data).config, 'adapters: [\n');
    const run = await ot(['vault', 'use', 'auto']);
    expect(run.code).toBe(1);
    expect(await config()).toBe('adapters: [\n');
    expect((await ot(['vault', 'status'])).code).toBe(1);
  });

  it('wrong usage exits with 2', async () => {
    for (const argv of [
      ['vault'],
      ['vault', 'open'],
      ['vault', 'use'],
      ['vault', 'use', 'memory'],
      ['vault', 'use', 'auto', 'extra'],
      ['vault', 'status', 'extra'],
    ]) {
      const run = await ot(argv);
      expect(run.code, argv.join(' ')).toBe(2);
    }
    expect((await ot(['vault', 'use', 'memory'])).err[0]).toContain('Unknown vault "memory"');
  });
});
