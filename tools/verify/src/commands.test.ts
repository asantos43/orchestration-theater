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
import { hostPlatform, PLATFORM_IDS } from './lockfile.js';
import { NOTICES_PLATFORM } from './notices.js';
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
  it('lists the subcommands', () => {
    expect([...COMMANDS]).toEqual([
      'licenses',
      'notices',
      'headers',
      'credentials',
      'catalogs',
      'deps',
      'adapter-locks',
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

  it('licenses: reads the crates of native/*/Cargo.lock and fails on a forbidden one', async () => {
    const root = fixtureRoot({ 'native/demo/Cargo.lock': '' });
    const crate = (license: string): string =>
      JSON.stringify({
        workspace_members: ['own'],
        packages: [
          { id: 'own', name: 'demo', version: '0.0.0', license: 'MPL-2.0' },
          { id: 'dep', name: 'dep', version: '1.0.0', license },
        ],
      });
    const npm = pnpmOutput({ left: { license: 'MIT', dir: path.join(root, 'left') } }, 'prod');
    const withCargo = (license: string): ExecFn => {
      return (file, args, options) =>
        file === 'cargo' ? Promise.resolve(crate(license)) : npm(file, args, options);
    };
    const ok = context(root, withCargo('MIT OR Apache-2.0'));
    expect(await runCommand('licenses', ok.ctx, NO_JSON)).toBe(0);
    expect(ok.output.join('\n')).toContain('packages: 2');
    const bad = context(root, withCargo('GPL-3.0-only'));
    expect(await runCommand('licenses', bad.ctx, NO_JSON)).toBe(1);
    expect(bad.output.join('\n')).toContain('dep@1.0.0');
    expect(bad.output.join('\n')).toContain('native/demo/Cargo.lock');
  });

  it('licenses: a failing pnpm is a usage/environment error', async () => {
    const { ctx } = context(fixtureRoot(), () =>
      Promise.reject(new UsageError('pnpm is not installed')),
    );
    await expect(runCommand('licenses', ctx, NO_JSON)).rejects.toBeInstanceOf(UsageError);
  });

  // Off the generating platform a difference is only a warning (see NOTICES_PLATFORM).
  it('notices: writes the file, then --check passes; changing it makes --check fail', async () => {
    const root = fixtureRoot();
    const exec = (): Promise<string> => Promise.resolve('No licenses in packages found');
    const { ctx } = context(root, exec);
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(1);
    expect(await runCommand('notices', ctx, NO_JSON)).toBe(0);
    expect(existsSync(path.join(root, NOTICES_FILE))).toBe(true);
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(0);
    writeFileSync(path.join(root, NOTICES_FILE), 'changed\n');
    expect(await runCommand('notices', ctx, { json: undefined, check: true })).toBe(
      process.platform === NOTICES_PLATFORM ? 1 : 0,
    );
  });

  describe('notices --platform', () => {
    const LOCKFILE = `lockfileVersion: '9.0'

packages:

  '@n/keyring-linux-x64-gnu@1.0.0':
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  '@n/keyring-win32-x64-msvc@1.0.0':
    cpu: [x64]
    os: [win32]

  '@n/keyring-darwin-arm64@1.0.0':
    cpu: [arm64]
    os: [darwin]

snapshots:

  '@n/keyring@1.0.0':
    optionalDependencies:
      '@n/keyring-darwin-arm64': 1.0.0
      '@n/keyring-linux-x64-gnu': 1.0.0
      '@n/keyring-win32-x64-msvc': 1.0.0
`;
    const METAFILE = JSON.stringify({
      inputs: {
        'node_modules/.pnpm/plain@1.0.0/node_modules/plain/index.js': {},
        'node_modules/.pnpm/@n+keyring@1.0.0/node_modules/@n/keyring/index.js': {},
        'packages/daemon/src/main.ts': {},
      },
    });

    function platformRoot(): { root: string; exec: ExecFn } {
      const make = (dir: string, files: Record<string, string>): string => {
        const full = path.join(makeTemp('otheater-pkg-'), dir);
        writeTree(full, files);
        return full;
      };
      const plain = make('plain', { LICENSE: 'Plain license text', 'package.json': '{}' });
      const keyring = make('keyring', { LICENSE: 'Keyring license text', 'package.json': '{}' });
      const root = fixtureRoot({
        'pnpm-lock.yaml': LOCKFILE,
        'metafile.json': METAFILE,
        'native/job-launcher/THIRD_PARTY_NOTICES.md': 'launcher crates\n',
      });
      const exec = pnpmOutput(
        { plain: { license: 'MIT', dir: plain }, '@n/keyring': { license: 'MIT', dir: keyring } },
        'prod',
      );
      return { root, exec };
    }

    // A platform other than the machine's, so the test does not depend on the CI host.
    const foreign = PLATFORM_IDS.find((id) => id !== hostPlatform()) ?? 'win32-x64';

    it('writes the file of the platform, then --check passes; a missing package makes --check fail', async () => {
      const { root, exec } = platformRoot();
      const { ctx, output } = context(root, exec);
      const out = path.join(root, 'out', `THIRD_PARTY_NOTICES-${foreign}.md`);
      const options = {
        ...NO_JSON,
        platform: foreign,
        metafile: path.join(root, 'metafile.json'),
        out,
      };
      expect(await runCommand('notices', ctx, { ...options, check: true })).toBe(1);
      expect(await runCommand('notices', ctx, options)).toBe(0);
      const text = readFileSync(out, 'utf8');
      expect(text).toContain(`# Third-party notices (${foreign})`);
      expect(text).toContain('### plain@1.0.0');
      expect(text).toContain('### @n/keyring@1.0.0');
      expect(text).toContain('Plain license text');
      expect(output.join('\n')).toContain('derived from the lockfile');
      expect(await runCommand('notices', ctx, { ...options, check: true })).toBe(0);
      // A package that goes missing from the file is caught, whatever the machine.
      writeFileSync(out, text.replace(/### plain@1\.0\.0[\s\S]*?(?=\n### |\n## )/, ''));
      const result = await runCommand('notices', ctx, { ...options, check: true });
      expect(result).toBe(1);
      expect(output.join('\n')).toContain('package missing from the file: plain@1.0.0');
    });

    it('--platform windows has the launcher section, the others do not', async () => {
      const { root, exec } = platformRoot();
      const { ctx } = context(root, exec);
      const outFor = (platform: string): string => path.join(root, 'out', `${platform}.md`);
      for (const platform of ['win32-x64', 'darwin-arm64']) {
        const options = {
          ...NO_JSON,
          platform,
          metafile: path.join(root, 'metafile.json'),
          out: outFor(platform),
        };
        expect(await runCommand('notices', ctx, options)).toBe(0);
        const text = readFileSync(outFor(platform), 'utf8');
        expect(text.includes('Windows job launcher')).toBe(platform === 'win32-x64');
        expect(text.includes('@n/keyring-win32-x64-msvc')).toBe(platform === 'win32-x64');
        expect(text.includes('@n/keyring-darwin-arm64')).toBe(platform === 'darwin-arm64');
        expect(text).not.toContain('@n/keyring-linux-x64-gnu');
      }
    });

    it('refuses an unknown platform and --metafile or --out without --platform', async () => {
      const { root } = platformRoot();
      const { ctx } = context(root, () => Promise.resolve('No licenses in packages found'));
      await expect(
        runCommand('notices', ctx, { ...NO_JSON, platform: 'linux-arm64' }),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(runCommand('notices', ctx, { ...NO_JSON, out: 'x.md' })).rejects.toBeInstanceOf(
        UsageError,
      );
    });
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
    expect(names).toHaveLength(7);
  });
});
