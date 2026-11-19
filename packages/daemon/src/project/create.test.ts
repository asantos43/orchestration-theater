// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { InvalidInput, ProjectConventionsSchema } from '@otheater/core';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import { createSoftwareProject } from './create.js';
import { detectConventions } from './detect.js';

const run = promisify(execFile);

afterAll(disposeTestGitIsolation);

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-create-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createSoftwareProject', () => {
  const vcs = defaultVcs();

  it('is born with the structure of the profile, the CI and one commit that carries it', async () => {
    const folder = join(root, 'shiny');
    const created = await createSoftwareProject({ vcs, folder });
    expect(created.branch).toBe('main');
    expect(ProjectConventionsSchema.safeParse(created.conventions).success).toBe(true);

    for (const file of [
      'README.md',
      '.gitignore',
      'CHANGELOG.md',
      'scripts/test.sh',
      '.github/workflows/ci.yml',
    ]) {
      expect((await stat(join(folder, file))).isFile()).toBe(true);
    }
    const ci = await readFile(join(folder, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('actions/checkout@v7');
    expect(ci).toContain('./scripts/test.sh');
    expect(ci).toContain('branches: ["main"]');
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toContain('# shiny');
    // Windows keeps no execute bit on disk; what matters there is the mode git records below.
    if (process.platform !== 'win32') {
      expect((await stat(join(folder, 'scripts', 'test.sh'))).mode & 0o111).not.toBe(0);
    }

    // Git has the script as executable, and the work tree is clean: everything is committed.
    expect(await testGit(folder, 'ls-files', '-s', 'scripts/test.sh')).toMatch(/^100755 /);
    expect((await testGit(folder, 'status', '--porcelain')).trim()).toBe('');
    expect((await testGit(folder, 'rev-parse', 'HEAD')).trim()).toBe(created.head);
    expect((await testGit(folder, 'log', '--format=%s')).trim().split('\n')).toEqual([
      'chore: scaffold the project from the software profile',
      'chore: initial commit',
    ]);
  });

  it('ships a test script that warns that no test is configured and exits 0, and the README says so', async () => {
    const folder = join(root, 'placeholder');
    await createSoftwareProject({ vcs, folder });
    const { stdout } = await run('sh', [join(folder, 'scripts', 'test.sh')]);
    expect(stdout).toContain('No tests configured; edit scripts/test.sh');
    const readme = await readFile(join(folder, 'README.md'), 'utf8');
    expect(readme).toContain('no tests configured; edit');
    expect(readme).toContain('exits 0');
  });

  it('is read back as the conventions it declares', async () => {
    const folder = join(root, 'again');
    const created = await createSoftwareProject({ vcs, folder, name: 'Again', branch: 'trunk' });
    expect(created.branch).toBe('trunk');
    const found = await detectConventions({ vcs, repo: folder });
    expect(found).toMatchObject({
      mainBranch: 'trunk',
      changelog: { format: 'keep-a-changelog', file: 'CHANGELOG.md' },
      commit: { style: 'conventional' },
      ci: 'github-actions',
    });
    expect(created.conventions.commands.test).toBe('./scripts/test.sh');
  });

  it('accepts an empty folder and refuses one that has something in it', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    await createSoftwareProject({ vcs, folder: empty });

    const used = join(root, 'used');
    await mkdir(used);
    await writeFile(join(used, 'a.txt'), 'x\n');
    await expect(createSoftwareProject({ vcs, folder: used })).rejects.toBeInstanceOf(InvalidInput);
  });
});
