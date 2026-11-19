// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binOnPath,
  findOnPath,
  RC_BEGIN,
  rcFileOf,
  rcShellOf,
  shimContent,
  syncShims,
  updateRcFile,
  withoutRcBlock,
  withRcBlock,
  type OtLauncher,
} from './shims.js';

const run = promisify(execFile);
const posix = process.platform !== 'win32';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-shims-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const LAUNCHER: OtLauncher = { node: '/opt/node/bin/node', entry: "/opt/ot's/cli.js" };

describe('shimContent (P28b, N159)', () => {
  it('only calls ot profile exec, with every path quoted', () => {
    const text = shimContent('posix', LAUNCHER, '/data dir', 'codex/personal');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain(
      `exec '/opt/node/bin/node' '/opt/ot'\\''s/cli.js' --data-dir '/data dir' profile exec 'codex/personal' -- "$@"`,
    );
    const cmd = shimContent(
      'win32',
      { node: 'C:\\node.exe', entry: 'C:\\ot\\cli.js' },
      'C:\\d',
      'codex/p',
    );
    expect(cmd).toContain(
      '"C:\\node.exe" "C:\\ot\\cli.js" --data-dir "C:\\d" profile exec "codex/p" -- %*',
    );
    expect(() => shimContent('win32', LAUNCHER, 'C:\\100%', 'codex/p')).toThrow();
  });

  it.runIf(posix)('passes every argument as it was, through a real sh', async () => {
    // A launcher that prints its arguments, one per line, in place of node.
    const echo = join(root, 'echo-args');
    await writeFile(echo, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    await chmod(echo, 0o755);
    const shim = join(root, 'codex-p');
    await writeFile(shim, shimContent('posix', { node: echo, entry: '/e.js' }, '/d', 'codex/p'));
    await chmod(shim, 0o755);
    const { stdout } = await run(shim, ['run', 'a b', '$HOME', "it's"]);
    expect(stdout.split('\n')).toEqual([
      '/e.js',
      '--data-dir',
      '/d',
      'profile',
      'exec',
      'codex/p',
      '--',
      'run',
      'a b',
      '$HOME',
      "it's",
      '',
    ]);
  });
});

describe.runIf(posix)('syncShims', () => {
  const profiles = [
    { id: 'codex/personal', client: 'codex', name: 'personal' },
    { id: 'claude-code/work', client: 'claude-code', name: 'work' },
  ];
  const input = (bin: string, path: string, prefix = '') => ({
    binDir: bin,
    dataDir: '/data',
    prefix,
    launcher: LAUNCHER,
    platform: 'posix' as const,
    env: { PATH: path },
    profiles,
  });

  it('writes one executable script per profile, then keeps them', async () => {
    const bin = join(root, 'bin');
    const first = await syncShims(input(bin, '/nowhere'));
    expect([...first.written].sort()).toEqual(['claude-code-work', 'codex-personal']);
    expect((await stat(join(bin, 'codex-personal'))).mode & 0o777).toBe(0o700);
    const again = await syncShims(input(bin, '/nowhere'));
    expect(again).toMatchObject({ written: [], removed: [], conflicts: [] });
    expect([...again.kept].sort()).toEqual(['claude-code-work', 'codex-personal']);
  });

  it('removes the scripts no profile has, and never a file it did not write', async () => {
    const bin = join(root, 'bin');
    await syncShims(input(bin, '/nowhere'));
    await writeFile(join(bin, 'mine'), '#!/bin/sh\necho mine\n');
    const result = await syncShims({ ...input(bin, '/nowhere'), profiles: profiles.slice(0, 1) });
    expect(result.removed).toEqual(['claude-code-work']);
    expect((await readdir(bin)).sort()).toEqual(['codex-personal', 'mine']);
  });

  it('uses the prefix, and does not create a name another program has in PATH', async () => {
    const bin = join(root, 'bin');
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(other, 'codex-personal'), '#!/bin/sh\n');
    await chmod(join(other, 'codex-personal'), 0o755);
    const path = `${bin}:${other}`;
    const result = await syncShims(input(bin, path));
    expect(result.conflicts).toEqual([
      { profileId: 'codex/personal', name: 'codex-personal', at: join(other, 'codex-personal') },
    ]);
    expect(await readdir(bin)).toEqual(['claude-code-work']);
    // Its own script in bin does not count as a conflict; with a prefix there is none.
    expect([...(await syncShims(input(bin, path, 'ot-'))).written].sort()).toEqual([
      'ot-claude-code-work',
      'ot-codex-personal',
    ]);
  });

  it('a file that is not executable is not a conflict', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(other, 'codex-personal'), 'text');
    expect(
      await findOnPath('codex-personal', { PATH: other }, 'posix', join(root, 'bin')),
    ).toBeUndefined();
  });
});

describe('PATH and the rc file', () => {
  it('knows whether bin is in PATH', () => {
    expect(binOnPath({ PATH: '/a:/data/bin/' }, 'posix', '/data/bin')).toBe(true);
    expect(binOnPath({ PATH: '/a' }, 'posix', '/data/bin')).toBe(false);
  });

  it('finds the shell and its rc file', () => {
    expect(rcShellOf({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(rcShellOf({ SHELL: '/bin/tcsh' })).toBeUndefined();
    expect(rcFileOf('zsh', { ZDOTDIR: '/z' }, '/h')).toBe(join('/z', '.zshrc'));
    expect(rcFileOf('bash', {}, '/h')).toBe(join('/h', '.bashrc'));
    expect(rcFileOf('fish', {}, '/h')).toBe(join('/h', '.config', 'fish', 'config.fish'));
  });

  it('adds, replaces and removes the block, keeping the rest as it was', () => {
    const before = 'alias ll="ls -l"\n';
    const added = withRcBlock(before, 'zsh', '/d/bin');
    expect(added).toBe(
      `${before}\n${RC_BEGIN}\nexport PATH='/d/bin':"$PATH"\n# <<< otheater profile commands <<<\n`,
    );
    expect(withRcBlock(added, 'zsh', '/e/bin')).toContain(`export PATH='/e/bin'`);
    expect(withRcBlock(added, 'zsh', '/e/bin').match(/>>> otheater/g)).toHaveLength(1);
    expect(withoutRcBlock(added)).toBe(before);
    expect(withoutRcBlock(before)).toBe(before);
    expect(withRcBlock('', 'fish', '/d/bin')).toContain(`set -gx PATH '/d/bin' $PATH`);
  });

  it.runIf(posix)('writes the rc file in place: its mode and a link stay', async () => {
    const real = join(root, 'dotfiles-zshrc');
    await writeFile(real, 'setopt x\n');
    await chmod(real, 0o640);
    const link = join(root, '.zshrc');
    await symlink(real, link);
    expect(await updateRcFile(link, { install: true, shell: 'zsh', binDir: '/d/bin' })).toBe(
      'added',
    );
    expect(await updateRcFile(link, { install: true, shell: 'zsh', binDir: '/d/bin' })).toBe(
      'unchanged',
    );
    expect((await stat(real)).mode & 0o777).toBe(0o640);
    expect(await readFile(real, 'utf8')).toContain(RC_BEGIN);
    expect(await updateRcFile(link, { install: false })).toBe('removed');
    expect(await readFile(real, 'utf8')).toBe('setopt x\n');
    expect(await updateRcFile(link, { install: false })).toBe('absent');
  });

  it.runIf(posix)('the line works in a real sh', async () => {
    const block = withRcBlock('', 'bash', "/d i'r/bin");
    const { stdout } = await run('sh', [
      '-c',
      `PATH=/usr/bin:/bin; ${block.split('\n')[1] ?? ''}; printf %s "$PATH"`,
    ]);
    expect(stdout).toBe("/d i'r/bin:/usr/bin:/bin");
  });
});
