// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindExecutable } from './clients.js';
import { pathFinder } from './clients.js';
import { readInstalledVersion, resolveClientVersioning } from './client-version.js';

// N63: the version of an installed client is read from a `package.json`, never by running it.
// Every folder here is made by the test; the `PATH` of the machine is never searched.

const ACP = '@agentclientprotocol/codex-acp';
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-client-version-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Install {
  /** The folder in `PATH`. */
  readonly bin: string;
  /** `PATH` search over just that folder. */
  readonly find: FindExecutable;
  /** The folder of the package. */
  readonly pkg: string;
}

/** A `bin` folder with `command` linked to `<prefix>/node_modules/<name>/dist/cli.js`. */
async function install(options: {
  name: string;
  packageJson: unknown;
  command?: string;
}): Promise<Install> {
  counter += 1;
  const base = join(root, `install-${String(counter)}`);
  const pkg = join(base, 'lib', 'node_modules', ...options.name.split('/'));
  const bin = join(base, 'bin');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify(options.packageJson));
  await writeFile(join(pkg, 'dist', 'cli.js'), '#!/bin/sh\nexit 1\n');
  await chmod(join(pkg, 'dist', 'cli.js'), 0o755);
  await symlink(join(pkg, 'dist', 'cli.js'), join(bin, options.command ?? 'codex-acp'));
  return { bin, find: pathFinder({ PATH: bin }), pkg };
}

describe('readInstalledVersion', () => {
  it('finds the package.json above the real file a symlink in PATH points to', async () => {
    const { find } = await install({ name: ACP, packageJson: { name: ACP, version: '2.6.0' } });
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBe('2.6.0');
  });

  it('finds it when the command is a plain file inside the package, with no link', async () => {
    const { pkg } = await install({ name: ACP, packageJson: { name: ACP, version: '1.0.1' } });
    const find: FindExecutable = () => join(pkg, 'dist', 'cli.js');
    expect(readInstalledVersion({ command: 'x', packages: [ACP], find })).toBe('1.0.1');
  });

  it('is undefined when the package.json has another name', async () => {
    const { find } = await install({
      name: ACP,
      packageJson: { name: 'something-else', version: '2.6.0' },
    });
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it('keeps climbing past a package.json of another name until the right one', async () => {
    const { pkg, find } = await install({
      name: ACP,
      packageJson: { name: ACP, version: '3.1.0' },
    });
    await writeFile(
      join(pkg, 'dist', 'package.json'),
      JSON.stringify({ name: 'dist-type-marker', version: '0.0.0' }),
    );
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBe('3.1.0');
  });

  it('accepts any of the package names it is given', async () => {
    const { find } = await install({
      name: 'opencode-ai',
      packageJson: { name: 'opencode-ai', version: '1.19.5' },
      command: 'opencode',
    });
    expect(
      readInstalledVersion({ command: 'opencode', packages: ['other', 'opencode-ai'], find }),
    ).toBe('1.19.5');
  });

  it('is undefined when the command is not in PATH', () => {
    const find = pathFinder({ PATH: join(root, 'does-not-exist') });
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it('is undefined for a wrapper script outside any package', async () => {
    counter += 1;
    const bin = join(root, `wrapper-${String(counter)}`);
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex-acp'), '#!/bin/sh\nexec npx codex-acp\n');
    await chmod(join(bin, 'codex-acp'), 0o755);
    const find = pathFinder({ PATH: bin });
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it('is undefined for npx, which is a package of its own', async () => {
    const { find } = await install({
      name: 'npm',
      packageJson: { name: 'npm', version: '11.0.0' },
      command: 'npx',
    });
    expect(readInstalledVersion({ command: 'npx', packages: [ACP], find })).toBeUndefined();
  });

  it('is undefined for a broken link', async () => {
    counter += 1;
    const bin = join(root, `broken-${String(counter)}`);
    await mkdir(bin, { recursive: true });
    await symlink(join(root, 'nothing-here'), join(bin, 'codex-acp'));
    const find: FindExecutable = (command) => join(bin, command);
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it.each([
    ['no version', { name: ACP }],
    ['a number as version', { name: ACP, version: 2 }],
    ['a version with a space', { name: ACP, version: '2.0 beta' }],
    ['an empty version', { name: ACP, version: '' }],
    ['not an object', ['x']],
    ['null', null],
  ])('is undefined when the package.json has %s', async (_label, packageJson) => {
    const { find } = await install({ name: ACP, packageJson });
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it('is undefined when the package.json is not JSON', async () => {
    const { pkg, find } = await install({ name: ACP, packageJson: {} });
    await writeFile(join(pkg, 'package.json'), '{ not json');
    expect(readInstalledVersion({ command: 'codex-acp', packages: [ACP], find })).toBeUndefined();
  });

  it('never runs the command: a file that would leave a mark is only looked at', async () => {
    const { pkg, find } = await install({
      name: ACP,
      packageJson: { name: ACP, version: '1.0.0' },
    });
    const mark = join(pkg, 'ran');
    await writeFile(join(pkg, 'dist', 'cli.js'), `#!/bin/sh\ntouch '${mark}'\n`);
    readInstalledVersion({ command: 'codex-acp', packages: [ACP], find });
    const { existsSync } = await import('node:fs');
    expect(existsSync(mark)).toBe(false);
  });
});

describe('resolveClientVersioning', () => {
  const unknown = { version: 'unknown', source: 'unknown' } as const;

  async function input(
    mode: 'auto' | 'package_json' | 'initialize' | 'config',
    written = 'unknown',
  ) {
    const { find } = await install({ name: ACP, packageJson: { name: ACP, version: '2.6.0' } });
    return { mode, written, command: 'codex-acp', packages: [ACP], find };
  }

  it('auto: reads the package.json and lets the initialize confirm or correct it', async () => {
    expect(resolveClientVersioning(await input('auto'))).toEqual({
      initial: { version: '2.6.0', source: 'package_json' },
      confirmByInitialize: true,
    });
  });

  it('auto: unknown when no package.json is found, and the initialize may fill it in', async () => {
    const lost = { ...(await input('auto')), find: (() => undefined) as FindExecutable };
    expect(resolveClientVersioning(lost)).toEqual({ initial: unknown, confirmByInitialize: true });
  });

  it('package_json: reads it and the initialize never corrects it', async () => {
    expect(resolveClientVersioning(await input('package_json'))).toEqual({
      initial: { version: '2.6.0', source: 'package_json' },
      confirmByInitialize: false,
    });
  });

  it('package_json: unknown, and stays so, when nothing is found', async () => {
    const lost = { ...(await input('package_json')), find: (() => undefined) as FindExecutable };
    expect(resolveClientVersioning(lost)).toEqual({ initial: unknown, confirmByInitialize: false });
  });

  it('initialize: reads no file at all and waits for the first session', async () => {
    const reads: string[] = [];
    const spy: FindExecutable = (command) => {
      reads.push(command);
      return undefined;
    };
    expect(resolveClientVersioning({ ...(await input('initialize')), find: spy })).toEqual({
      initial: unknown,
      confirmByInitialize: true,
    });
    expect(reads).toEqual([]);
  });

  it('config: neither reads a file nor listens to the initialize, and stays unknown', async () => {
    expect(resolveClientVersioning(await input('config'))).toEqual({
      initial: unknown,
      confirmByInitialize: false,
    });
  });

  it.each(['auto', 'package_json', 'initialize', 'config'] as const)(
    '%s: a written client_version wins over everything and is never corrected',
    async (mode) => {
      expect(resolveClientVersioning(await input(mode, '9.9.9'))).toEqual({
        initial: { version: '9.9.9', source: 'config' },
        confirmByInitialize: false,
      });
    },
  );
});
