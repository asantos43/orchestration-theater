// SPDX-License-Identifier: MPL-2.0
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confineArgv, confinePath, type PathHost } from './confine.js';
import { ShellToolRefusal, type ShellRefusalReason } from './refusal.js';

const host: PathHost = {
  sep,
  realpath: (path) => realpath(path),
  isSymlink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch {
      return false;
    }
  },
};

let base = '';
let root = '';
let outside = '';

async function refusal(promise: Promise<unknown>): Promise<ShellRefusalReason> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ShellToolRefusal) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'otheater-confine-')));
  root = join(base, 'worktree');
  outside = join(base, 'outside');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'a');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  // A symlink of a file, of a folder, a chain of two, one inside, one dangling and a loop.
  await symlink(join(outside, 'secret.txt'), join(root, 'file-link'));
  await symlink(outside, join(root, 'dir-link'));
  await symlink(join(root, 'file-link'), join(root, 'chain-1'));
  await symlink(join(root, 'chain-1'), join(root, 'chain-2'));
  await symlink(join(root, 'src'), join(root, 'inner-link'));
  await symlink(join(base, 'nowhere'), join(root, 'dangling'));
  await symlink(join(root, 'loop-b'), join(root, 'loop-a'));
  await symlink(join(root, 'loop-a'), join(root, 'loop-b'));
  await symlink(root, join(base, 'root-alias'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('confinePath', () => {
  it('resolves relative paths, existing or not, inside the worktree', async () => {
    expect(await confinePath(host, root, '.')).toBe(root);
    expect(await confinePath(host, root, '')).toBe(root);
    expect(await confinePath(host, root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(await confinePath(host, root, './src//deep/../a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(await confinePath(host, root, 'src/new/file.ts')).toBe(
      join(root, 'src', 'new', 'file.ts'),
    );
    expect(await confinePath(host, root, 'src/new/../other.ts')).toBe(
      join(root, 'src', 'other.ts'),
    );
  });

  it('accepts an absolute path that starts at the worktree, by its given or real name', async () => {
    expect(await confinePath(host, root, join(root, 'src'))).toBe(join(root, 'src'));
    const alias = join(base, 'root-alias');
    expect(await confinePath(host, alias, join(alias, 'src', 'a.ts'))).toBe(
      join(root, 'src', 'a.ts'),
    );
    expect(await confinePath(host, alias, join(root, 'src', 'a.ts'))).toBe(
      join(root, 'src', 'a.ts'),
    );
  });

  it('refuses ".." that climbs out, however it is written', async () => {
    expect(await refusal(confinePath(host, root, '..'))).toBe('path_escapes');
    expect(await refusal(confinePath(host, root, '../outside/secret.txt'))).toBe('path_escapes');
    expect(await refusal(confinePath(host, root, 'src/../../outside'))).toBe('path_escapes');
    expect(await refusal(confinePath(host, root, 'src/deep/../../../x'))).toBe('path_escapes');
    // Out and back in is refused too: the step outside is the problem.
    expect(await refusal(confinePath(host, root, '../worktree/src'))).toBe('path_escapes');
  });

  it('refuses an absolute path outside the worktree, and a sibling with the same prefix', async () => {
    expect(await refusal(confinePath(host, root, '/etc/passwd'))).toBe('path_escapes');
    expect(await refusal(confinePath(host, root, join(outside, 'secret.txt')))).toBe(
      'path_escapes',
    );
    expect(await refusal(confinePath(host, root, `${root}-sibling/x`))).toBe('path_escapes');
    expect(await refusal(confinePath(host, root, `${root}/../outside/secret.txt`))).toBe(
      'path_escapes',
    );
  });

  it('refuses a symlink of a file that points out', async () => {
    expect(await refusal(confinePath(host, root, 'file-link'))).toBe('symlink_escapes');
  });

  it('refuses a symlink of a folder that points out, and whatever is under it', async () => {
    expect(await refusal(confinePath(host, root, 'dir-link'))).toBe('symlink_escapes');
    expect(await refusal(confinePath(host, root, 'dir-link/secret.txt'))).toBe('symlink_escapes');
    expect(await refusal(confinePath(host, root, 'dir-link/new-file.txt'))).toBe('symlink_escapes');
  });

  it('refuses a chain of symlinks that ends outside', async () => {
    expect(await refusal(confinePath(host, root, 'chain-1'))).toBe('symlink_escapes');
    expect(await refusal(confinePath(host, root, 'chain-2'))).toBe('symlink_escapes');
  });

  it('reads "link/.." as the parent of the target, not of the link', async () => {
    expect(await refusal(confinePath(host, root, 'dir-link/..'))).toBe('symlink_escapes');
    // Lexically inner-link/.. would be the worktree; for the kernel it is the parent of src, which is too.
    expect(await confinePath(host, root, 'inner-link/..')).toBe(root);
  });

  it('follows a symlink that stays inside', async () => {
    expect(await confinePath(host, root, 'inner-link/a.ts')).toBe(join(root, 'src', 'a.ts'));
  });

  it('refuses a dangling symlink and a loop', async () => {
    expect(await refusal(confinePath(host, root, 'dangling'))).toBe('invalid_path');
    expect(await refusal(confinePath(host, root, 'dangling/x'))).toBe('invalid_path');
    expect(await refusal(confinePath(host, root, 'loop-a'))).toBe('invalid_path');
  });

  it('refuses NUL and a root that is not absolute or does not exist', async () => {
    expect(await refusal(confinePath(host, root, 'a\0b'))).toBe('invalid_path');
    expect(await refusal(confinePath(host, 'relative/root', 'a'))).toBe('invalid_path');
    expect(await refusal(confinePath(host, join(base, 'missing'), 'a'))).toBe('invalid_path');
  });
});

describe('confineArgv', () => {
  it('lets arguments that are not paths, and paths inside, through', async () => {
    await confineArgv(host, root, ['git', 'status']);
    await confineArgv(host, root, [
      'git',
      'log',
      '-n',
      '5',
      '--format=%H',
      'HEAD~2',
      'main..feature',
    ]);
    await confineArgv(host, root, ['cat', 'src/a.ts', 'src/not-yet.ts']);
    await confineArgv(host, root, ['rg', '-n', 'foo/bar', '--', 'src']);
    await confineArgv(host, root, ['ls', `--color=${join(root, 'src')}`]);
  });

  it('refuses a path that climbs out or lies elsewhere', async () => {
    expect(await refusal(confineArgv(host, root, ['cat', '../outside/secret.txt']))).toBe(
      'path_escapes',
    );
    expect(await refusal(confineArgv(host, root, ['cat', '/etc/passwd']))).toBe('path_escapes');
    expect(await refusal(confineArgv(host, root, ['ls', '..']))).toBe('path_escapes');
    expect(await refusal(confineArgv(host, root, ['cat', '--file=../x']))).toBe('path_escapes');
    expect(await refusal(confineArgv(host, root, ['cat', '--', '../x']))).toBe('path_escapes');
  });

  it('refuses the home folder', async () => {
    expect(await refusal(confineArgv(host, root, ['cat', '~/.ssh/id_ed25519']))).toBe(
      'path_escapes',
    );
    expect(await refusal(confineArgv(host, root, ['cat', '--config=~/x']))).toBe('path_escapes');
  });

  it('refuses a bare name that is a symlink out', async () => {
    expect(await refusal(confineArgv(host, root, ['cat', 'file-link']))).toBe('symlink_escapes');
    expect(await refusal(confineArgv(host, root, ['ls', 'dir-link']))).toBe('symlink_escapes');
    expect(await refusal(confineArgv(host, root, ['cat', 'chain-2']))).toBe('symlink_escapes');
    expect(await refusal(confineArgv(host, root, ['cat', 'dir-link/secret.txt']))).toBe(
      'symlink_escapes',
    );
  });
});
