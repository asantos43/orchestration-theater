// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testGit } from '@otheater/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import {
  commitStyleOf,
  detectChangelogFormat,
  detectCommands,
  detectConventions,
  findChangelog,
} from './detect.js';

let repo: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'otheater-detect-')));
  await testGit(repo, 'init', '--quiet', '--initial-branch=main');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** One commit per subject, each with its own file, oldest first. */
async function commits(...subjects: string[]): Promise<void> {
  let index = 0;
  for (const subject of subjects) {
    index += 1;
    await writeFile(join(repo, `${subject.replace(/\W+/g, '-')}-${String(index)}.txt`), 'x\n');
    await testGit(repo, 'add', '-A');
    await testGit(repo, 'commit', '--quiet', '-m', subject);
  }
}

const KEEP = [
  '# Changelog',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
  '',
  '## [Unreleased]',
  '',
  '## [1.0.0] - 2026-01-01',
  '',
  '### Added',
  '',
  '- first release',
  '',
].join('\n');

const CONVENTIONAL = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.',
  '',
  '## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-02-01)',
  '',
  '### Features',
  '',
  '* a feature',
  '',
].join('\n');

describe('detectChangelogFormat', () => {
  it('recognizes Keep a Changelog by its link, its Unreleased heading or its subsections', () => {
    expect(detectChangelogFormat(KEEP)).toBe('keep-a-changelog');
    expect(detectChangelogFormat('# Log\n\n## Unreleased\n\n- x\n')).toBe('keep-a-changelog');
    expect(detectChangelogFormat('# Log\n\n## 1.0.0\n\n### Fixed\n\n- x\n')).toBe(
      'keep-a-changelog',
    );
  });

  it('recognizes the file conventional-changelog writes', () => {
    expect(detectChangelogFormat(CONVENTIONAL)).toBe('conventional-changelog');
    expect(detectChangelogFormat('# 1.0.0\n\n### Bug Fixes\n\n* x\n')).toBe(
      'conventional-changelog',
    );
  });

  it('calls anything else other', () => {
    expect(detectChangelogFormat('v1.0 - first\nv1.1 - second\n')).toBe('other');
    expect(detectChangelogFormat('')).toBe('other');
  });
});

describe('commitStyleOf', () => {
  it('is conventional when most of the subjects follow Conventional Commits', () => {
    expect(
      commitStyleOf(['feat: a', 'fix(core): b', 'docs!: c', 'chore: d', 'Update the readme']),
    ).toBe('conventional');
  });

  it('is free when most of the subjects do not', () => {
    expect(commitStyleOf(['Add a', 'Fix b', 'feat: c', 'Update d'])).toBe('free');
  });

  it('does not count the subjects git and the bootstrap write', () => {
    expect(commitStyleOf(['Merge branch x', 'Initial commit', 'feat: a', 'fix: b'])).toBe(
      'conventional',
    );
    expect(commitStyleOf(['Merge branch x', 'Initial commit'])).toBe('free');
    expect(commitStyleOf([])).toBe('free');
  });

  it('wants the space after the colon and a known type', () => {
    expect(commitStyleOf(['feat:a', 'wip: b', 'Feature: c'])).toBe('free');
  });
});

describe('findChangelog', () => {
  it('finds the file whatever its case and extension', async () => {
    await writeFile(join(repo, 'Changelog.markdown'), KEEP);
    expect(await findChangelog(repo)).toEqual({ file: 'Changelog.markdown', text: KEEP });
  });

  it('prefers CHANGELOG over HISTORY and finds nothing in a repository without one', async () => {
    expect(await findChangelog(repo)).toBeUndefined();
    await writeFile(join(repo, 'HISTORY.md'), 'old\n');
    await writeFile(join(repo, 'CHANGELOG.md'), KEEP);
    expect((await findChangelog(repo))?.file).toBe('CHANGELOG.md');
  });

  it('ignores a folder with the name of a changelog', async () => {
    await mkdir(join(repo, 'changelog'));
    expect(await findChangelog(repo)).toBeUndefined();
  });
});

describe('detectCommands', () => {
  it('reads the scripts of package.json with the package manager of the lock file', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    expect(await detectCommands(repo)).toEqual({ test: 'npm test', install: 'npm install' });
    await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(await detectCommands(repo)).toEqual({ test: 'pnpm test', install: 'pnpm install' });
  });

  it('does not take the placeholder of npm init for a test command', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    expect(await detectCommands(repo)).toEqual({ install: 'npm install' });
  });

  it('survives a package.json that does not parse', async () => {
    await writeFile(join(repo, 'package.json'), '{ not json');
    expect(await detectCommands(repo)).toEqual({ install: 'npm install' });
  });

  it('knows cargo, go and a make target', async () => {
    await writeFile(join(repo, 'Cargo.toml'), '[package]\n');
    expect(await detectCommands(repo)).toEqual({ test: 'cargo test', install: 'cargo fetch' });
    await rm(join(repo, 'Cargo.toml'));
    await writeFile(join(repo, 'go.mod'), 'module x\n');
    expect(await detectCommands(repo)).toEqual({
      test: 'go test ./...',
      install: 'go mod download',
    });
    await rm(join(repo, 'go.mod'));
    await writeFile(join(repo, 'Makefile'), 'build:\n\ttrue\n\ntest:\n\ttrue\n');
    expect(await detectCommands(repo)).toEqual({ test: 'make test' });
  });

  it('says nothing for a repository that tells nothing', async () => {
    expect(await detectCommands(repo)).toEqual({});
  });
});

describe('detectConventions', () => {
  const vcs = defaultVcs();

  it('detects a repository of Conventional Commits with a Keep a Changelog file and CI', async () => {
    await commits('feat: one', 'fix(core): two', 'docs: three');
    await writeFile(join(repo, 'CHANGELOG.md'), KEEP);
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const found = await detectConventions({ vcs, repo });
    expect(found).toEqual({
      version: 1,
      source: 'detected',
      confirmed: false,
      mainBranch: 'main',
      changelog: { format: 'keep-a-changelog', file: 'CHANGELOG.md' },
      commit: { style: 'conventional', defaultType: 'feat' },
      ci: 'github-actions',
      commands: { test: 'npm test', install: 'npm install' },
    });
  });

  it('detects free commits, no changelog and no CI', async () => {
    await commits('Add the first thing', 'Fix the second thing');
    const found = await detectConventions({ vcs, repo });
    expect(found.commit.style).toBe('free');
    expect(found.changelog).toEqual({ format: 'none' });
    expect(found.ci).toBe('none');
    expect(found.commands).toEqual({});
  });

  it('recognizes a CI that is not GitHub Actions', async () => {
    await commits('a');
    await writeFile(join(repo, '.gitlab-ci.yml'), 'test:\n  script: true\n');
    expect((await detectConventions({ vcs, repo })).ci).toBe('other');
  });

  it('detects the main branch the repository uses and prefers the one the Producer named', async () => {
    await testGit(repo, 'checkout', '--quiet', '-b', 'trunk');
    await commits('a');
    expect((await detectConventions({ vcs, repo })).mainBranch).toBe('trunk');
    expect((await detectConventions({ vcs, repo, base: 'main' })).mainBranch).toBe('main');
  });

  it('reads the pattern from the branch it was told, not from the checkout', async () => {
    await commits('feat: a', 'fix: b');
    await testGit(repo, 'checkout', '--quiet', '-b', 'other');
    await commits('Free text one', 'Free text two', 'Free text three', 'Free text four');
    expect((await detectConventions({ vcs, repo, base: 'main' })).commit.style).toBe(
      'conventional',
    );
    expect((await detectConventions({ vcs, repo, base: 'other' })).commit.style).toBe('free');
  });

  it('works on a repository without commits', async () => {
    const found = await detectConventions({ vcs, repo });
    expect(found.commit.style).toBe('free');
    expect(found.confirmed).toBe(false);
  });
});
