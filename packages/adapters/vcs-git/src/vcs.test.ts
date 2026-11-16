// SPDX-License-Identifier: MPL-2.0
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { testGit } from '@otheater/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GIT_IDENTITY,
  GIT_VCS_ADAPTER,
  GitVcs,
  GitVcsConfigSchema,
  isolatedGitEnv,
} from './index.js';
import { parseNumstat, parseWorktreeList } from './vcs.js';

let root: string;
let repo: string;
let wt: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-vcs-git-')));
  repo = join(root, 'repo');
  wt = join(root, 'wt');
  await mkdir(repo);
  await mkdir(wt);
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, '.gitignore'), '.env\n');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'initial commit');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('identity and configuration', () => {
  it('declares the Vcs port', () => {
    expect(GIT_VCS_ADAPTER).toEqual({ id: 'git', implements: { port: 'Vcs', range: '^0.1.0' } });
    expect(new GitVcs().implements).toBe(GIT_VCS_ADAPTER.implements);
  });

  it('the config schema fills the defaults and refuses an unknown key', () => {
    expect(GitVcsConfigSchema.parse({})).toEqual({
      binary: 'git',
      timeoutMs: 60_000,
      identity: DEFAULT_GIT_IDENTITY,
      worktreeInclude: true,
    });
    expect(GitVcsConfigSchema.safeParse({ timeout: 5 }).success).toBe(false);
    expect(GitVcsConfigSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
  });

  it('refuses a bad timeout or an empty identity at construction', () => {
    expect(() => new GitVcs({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new GitVcs({ identity: { name: '', email: 'a@b' } })).toThrow(/identity/);
  });
});

describe('isolation from the user environment', () => {
  it('drops every inherited variable but a short list, and pins the config', () => {
    const env = isolatedGitEnv({
      PATH: '/bin',
      GIT_DIR: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_CONFIG_GLOBAL: '/home/someone/.gitconfig',
      GIT_AUTHOR_NAME: 'someone',
      HOME: '/home/someone',
      SSH_AUTH_SOCK: '/run/agent',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
      HOME: devNull,
      XDG_CONFIG_HOME: devNull,
      LC_ALL: 'C',
    });
    expect(
      Object.keys(env).filter((key) => key.startsWith('GIT_DIR') || key === 'GIT_INDEX_FILE'),
    ).toEqual([]);
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('a hostile global config, git variables and a hook change nothing and are not written', async () => {
    const home = join(root, 'home');
    await mkdir(home);
    const hook = join(root, 'global-hooks');
    await mkdir(hook);
    await writeFile(
      join(hook, 'pre-commit'),
      `#!/bin/sh\ntouch '${join(root, 'global-hook-ran')}'\nexit 1\n`,
    );
    await chmod(join(hook, 'pre-commit'), 0o755);
    const config = `[user]\n\tname = Someone Else\n\temail = someone@example.com\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hook}\n\texcludesFile = ${join(home, 'ignore')}\n`;
    await writeFile(join(home, '.gitconfig'), config);
    await writeFile(join(home, 'ignore'), 'wanted.txt\n');

    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      GIT_DIR: join(root, 'nonexistent.git'),
      GIT_INDEX_FILE: join(root, 'nonexistent-index'),
      GIT_AUTHOR_NAME: 'Env Author',
    });
    try {
      const vcs = new GitVcs();
      const path = join(wt, 'iso');
      await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
      await writeFile(join(path, 'wanted.txt'), 'listed in the global ignore of the user\n');
      const sha = await vcs.commitAll(path, 'isolated');
      expect(sha).toBeDefined();
      const author = await testGit(path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%G?');
      expect(author).toBe('OTheater <otheater@localhost>|OTheater <otheater@localhost>|N');
      // The user's global ignore is not applied.
      expect(await testGit(path, 'ls-tree', '--name-only', 'HEAD')).toContain('wanted.txt');
    } finally {
      for (const key of [
        'HOME',
        'XDG_CONFIG_HOME',
        'GIT_CONFIG_GLOBAL',
        'GIT_DIR',
        'GIT_INDEX_FILE',
        'GIT_AUTHOR_NAME',
      ]) {
        const value = saved[key];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
    expect(await readFile(join(home, '.gitconfig'), 'utf8')).toBe(config);
    await expect(stat(join(root, 'global-hook-ran'))).rejects.toThrow();
  });

  it('uses the identity of the constructor', async () => {
    const vcs = new GitVcs({ identity: { name: 'Robot', email: 'robot@example.test' } });
    const path = join(wt, 'who');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    await vcs.commitAll(path, 'by the robot', { allowEmpty: true });
    expect(await testGit(path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Robot <robot@example.test>',
    );
  });
});

describe('failures of the git executable', () => {
  it('a missing executable is AdapterUnavailable', async () => {
    const vcs = new GitVcs({ binary: join(root, 'no-such-git') });
    expect(await rejection(vcs.listWorktrees(repo))).toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });

  it('a command past the ceiling is killed and fails Transient', async () => {
    const slow = join(root, 'slow-git');
    await writeFile(slow, '#!/bin/sh\nexec sleep 30\n');
    await chmod(slow, 0o755);
    const vcs = new GitVcs({ binary: slow, timeoutMs: 300 });
    const started = Date.now();
    expect(await rejection(vcs.listWorktrees(repo))).toMatchObject({ code: 'TRANSIENT' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a git error carries the stderr in the message', async () => {
    const vcs = new GitVcs();
    const error = await rejection(vcs.listWorktrees(root));
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect((error as Error).message).toMatch(/not a git repository/i);
  });

  it('refuses relative paths and NUL characters', async () => {
    const vcs = new GitVcs();
    expect(await rejection(vcs.listWorktrees('repo'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await rejection(
        vcs.createWorktree({ repo, path: 'rel', branch: 'play/1/base', base: 'main' }),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await rejection(
        vcs.createWorktree({ repo, path: join(wt, 'a'), branch: 'x\0y', base: 'main' }),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never passes a branch or base starting with "-" to git as an option', async () => {
    const vcs = new GitVcs();
    const path = join(wt, 'opt');
    expect(
      await rejection(vcs.createWorktree({ repo, path, branch: 'play/1/base', base: '--detach' })),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await rejection(vcs.diffStat(repo, '--stat'))).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('concurrency', () => {
  it('serializes many creations on one repository', async () => {
    const vcs = new GitVcs();
    const names = Array.from({ length: 8 }, (_, index) => `w${String(index)}`);
    await Promise.all(
      names.map((name) =>
        vcs.createWorktree({
          repo,
          path: join(wt, name),
          branch: `play/60/attempts/d/${name}`,
          base: 'main',
        }),
      ),
    );
    expect(await vcs.listWorktrees(repo)).toHaveLength(9);
    await Promise.all(
      names.map((name) => vcs.removeWorktree(join(wt, name), { deleteBranch: true })),
    );
    expect(await vcs.listWorktrees(repo)).toHaveLength(1);
    expect(await vcs.listPlayBranches(repo, '60')).toEqual([]);
  });

  it('two creations of the same branch at once: one wins, the other is a Conflict', async () => {
    const vcs = new GitVcs();
    const results = await Promise.allSettled([
      vcs.createWorktree({ repo, path: join(wt, 'a'), branch: 'play/61/base', base: 'main' }),
      vcs.createWorktree({ repo, path: join(wt, 'b'), branch: 'play/61/base', base: 'main' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed).toMatchObject({ reason: { code: 'CONFLICT' } });
  });
});

describe('the branches of a play', () => {
  it('lists and deletes only the branches under play/<id>/', async () => {
    const vcs = new GitVcs();
    for (const [name, branch] of [
      ['a', 'play/4/base'],
      ['b', 'play/4/attempts/d1/1'],
      ['c', 'play/42/base'],
    ] as const) {
      await vcs.createWorktree({ repo, path: join(wt, name), branch, base: 'main' });
    }
    await testGit(repo, 'branch', 'play/4/integration', 'main');
    await testGit(repo, 'branch', 'other', 'main');

    expect(await vcs.listPlayBranches(repo, '4')).toEqual([
      'play/4/attempts/d1/1',
      'play/4/base',
      'play/4/integration',
    ]);
    expect(await vcs.listPlayBranches(repo, '99')).toEqual([]);
    expect(await rejection(vcs.listPlayBranches(repo, 'Bad Id'))).toMatchObject({
      code: 'INVALID_INPUT',
    });

    // Two are checked out in worktrees: nothing is deleted.
    expect(await rejection(vcs.deletePlayBranches(repo, '4'))).toMatchObject({ code: 'CONFLICT' });
    expect(await vcs.listPlayBranches(repo, '4')).toHaveLength(3);

    await vcs.removeWorktree(join(wt, 'a'));
    await vcs.removeWorktree(join(wt, 'b'));
    expect(await vcs.deletePlayBranches(repo, '4')).toHaveLength(3);
    expect(await vcs.listPlayBranches(repo, '4')).toEqual([]);
    expect(await vcs.listPlayBranches(repo, '42')).toEqual(['play/42/base']);
    expect(await testGit(repo, 'branch', '--list', 'other')).toContain('other');
    expect(await vcs.deletePlayBranches(repo, '4')).toEqual([]);
  });
});

describe('.worktreeinclude', () => {
  async function seed(): Promise<void> {
    await writeFile(join(repo, '.worktreeinclude'), '.env\nlink.txt\n*.env\n!keep-out.env\n');
    await writeFile(join(repo, '.env'), 'A=1\n');
    await writeFile(join(repo, 'keep-out.env'), 'B=2\n');
    await mkdir(join(repo, 'nested'));
    await writeFile(join(repo, 'nested', 'local.env'), 'C=3\n');
    await writeFile(join(repo, '.gitignore'), '.env\n*.env\nlink.txt\n');
    await symlink(join(root, 'repo', 'README.md'), join(repo, 'link.txt'));
    await testGit(repo, 'add', '-A');
    await testGit(repo, 'commit', '--quiet', '-m', 'include setup');
  }

  it('follows the gitignore rules of git: nested paths, negation and the .gitignore needed too', async () => {
    await seed();
    const warnings: string[] = [];
    const vcs = new GitVcs({ onWarning: (message) => warnings.push(message) });
    const path = join(wt, 'inc');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('A=1\n');
    expect(await readFile(join(path, 'nested', 'local.env'), 'utf8')).toBe('C=3\n');
    // Negated by the include file itself.
    await expect(stat(join(path, 'keep-out.env'))).rejects.toThrow();
    // A symbolic link, even to a file inside the repository, is left out and reported.
    await expect(stat(join(path, 'link.txt'))).rejects.toThrow();
    expect(warnings).toEqual(['.worktreeinclude: link.txt not copied (symbolic link)']);
  });

  it('does not overwrite and reports a second copy', async () => {
    await seed();
    const vcs = new GitVcs();
    const path = join(wt, 'twice');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    await writeFile(join(path, '.env'), 'EDITED=1\n');
    const result = await vcs.copyWorktreeInclude(repo, path);
    expect(result.copied).not.toContain('.env');
    expect(result.skipped).toContainEqual({ path: '.env', reason: 'already exists' });
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('EDITED=1\n');
  });

  it('is off with worktreeInclude: false', async () => {
    await seed();
    const vcs = new GitVcs({ worktreeInclude: false });
    const path = join(wt, 'off');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    await expect(stat(join(path, '.env'))).rejects.toThrow();
  });

  it('a .worktreeinclude that is a link is not read', async () => {
    await writeFile(join(root, 'patterns'), '.env\n');
    await symlink(join(root, 'patterns'), join(repo, '.worktreeinclude'));
    await writeFile(join(repo, '.env'), 'A=1\n');
    const vcs = new GitVcs();
    const path = join(wt, 'linked');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    await expect(stat(join(path, '.env'))).rejects.toThrow();
  });
});

describe('unusual file names', () => {
  it('commitAll and diffStat handle spaces, tabs, quotes and non-ASCII names', async () => {
    const vcs = new GitVcs();
    const path = join(wt, 'names');
    await vcs.createWorktree({ repo, path, branch: 'play/1/base', base: 'main' });
    const names = [
      'with space.txt',
      'tab\there.txt',
      'quote"d.txt',
      'açaí-日本.txt',
      'new\nline.txt',
    ];
    for (const name of names) await writeFile(join(path, name), 'x\n');
    const stat = await vcs.diffStat(path, 'main');
    expect(stat.files.map((file) => file.path).sort()).toEqual([...names].sort());
    expect(stat.insertions).toBe(names.length);
    expect(await vcs.commitAll(path, 'odd names')).toBeDefined();
    expect((await vcs.diffStat(path, 'main')).filesChanged).toBe(names.length);
  });
});

describe('parsers', () => {
  it('parseWorktreeList reads main, branch, detached and skips a bare entry', () => {
    const output = [
      'worktree /r\0HEAD aaa\0branch refs/heads/main\0\0',
      'worktree /w1\0HEAD bbb\0branch refs/heads/play/1/base\0\0',
      'worktree /w2\0HEAD ccc\0detached\0locked\0\0',
    ].join('');
    expect(parseWorktreeList(output)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', main: true },
      { path: '/w1', head: 'bbb', branch: 'play/1/base', main: false },
      { path: '/w2', head: 'ccc', branch: undefined, main: false },
    ]);
    expect(parseWorktreeList('worktree /bare\0bare\0\0')).toEqual([]);
  });

  it('parseNumstat reads counts, binaries and an empty output', () => {
    expect(parseNumstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0, files: [] });
    expect(parseNumstat('3\t1\ta.txt\0-\t-\tb.bin\0')).toEqual({
      filesChanged: 2,
      insertions: 3,
      deletions: 1,
      files: [
        { path: 'a.txt', insertions: 3, deletions: 1 },
        { path: 'b.bin', insertions: undefined, deletions: undefined },
      ],
    });
  });
});
