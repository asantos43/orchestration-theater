// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInput, parseConventions } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import type { ConventionsMode } from '../config.js';
import { buildDaemonRegistries } from '../registries.js';
import { ScenarioService } from './service.js';

afterAll(disposeTestGitIsolation);

let root: string;
let store: InMemoryStore;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-service-conventions-')));
  store = new InMemoryStore({ clock: new FakeClock() });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(mode?: ConventionsMode): ScenarioService {
  return new ScenarioService({
    store,
    vcs: defaultVcs(),
    registries: buildDaemonRegistries(),
    scenariosDir: join(root, 'scenarios'),
    ...(mode === undefined ? {} : { conventionsMode: () => mode }),
  });
}

/** A repository with the given branch, a Keep a Changelog file and Conventional Commits. */
async function importedRepo(branch: string): Promise<string> {
  const repo = join(root, `imported-${branch}`);
  await testGit(root, 'init', '--quiet', `--initial-branch=${branch}`, repo);
  await writeFile(
    join(repo, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- first\n',
  );
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'feat: first');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  await testGit(repo, 'add', '-A');
  await testGit(repo, 'commit', '--quiet', '-m', 'fix: second');
  return repo;
}

describe('the conventions of a project scenario (P7)', () => {
  it('detects them when a repository is imported, and keeps them unconfirmed', async () => {
    const repo = await importedRepo('main');
    const { scenario, conventions } = await service().create({ type: 'project', repo });
    expect(conventions).toMatchObject({
      source: 'detected',
      confirmed: false,
      mainBranch: 'main',
      changelog: { format: 'keep-a-changelog', file: 'CHANGELOG.md' },
      commit: { style: 'conventional' },
    });
    const stored = await store.scenarios.get(scenario.id);
    expect(parseConventions(stored?.conventions)).toEqual(conventions);
  });

  it('does not detect again when the scenario is reopened: what is stored stays', async () => {
    const repo = await importedRepo('main');
    const first = await service().create({ type: 'project', repo });
    const confirmed = { ...first.conventions, confirmed: true, source: 'producer' } as const;
    await store.scenarios.update(first.scenario.id, {
      conventions: JSON.parse(JSON.stringify(confirmed)) as never,
    });
    await writeFile(join(repo, 'CHANGELOG.md'), 'nothing like before\n');
    const again = await service().create({ type: 'project', repo });
    expect(again.created).toBe(false);
    expect(again.conventions).toMatchObject({ source: 'producer', confirmed: true });
  });

  it('fills the conventions of a scenario that was created before them', async () => {
    const repo = await importedRepo('main');
    const first = await service().create({ type: 'project', repo });
    await store.scenarios.update(first.scenario.id, { conventions: null });
    const again = await service().create({ type: 'project', repo });
    expect(again.created).toBe(false);
    expect(again.conventions?.changelog.format).toBe('keep-a-changelog');
    expect(parseConventions((await store.scenarios.get(first.scenario.id))?.conventions)).toEqual(
      again.conventions,
    );
  });

  it('detects nothing with project.conventions off', async () => {
    const repo = await importedRepo('main');
    const { scenario, conventions } = await service('off').create({ type: 'project', repo });
    expect(conventions).toBeUndefined();
    expect((await store.scenarios.get(scenario.id))?.conventions).toBeNull();
  });

  it('takes the default branch of the repository when it has no main', async () => {
    const repo = await importedRepo('trunk');
    const { scenario, conventions } = await service().create({ type: 'project', repo });
    expect(scenario.baseBranch).toBe('trunk');
    expect(conventions?.mainBranch).toBe('trunk');
    // A branch that was named and does not exist is still refused.
    const other = await importedRepo('master');
    await expect(service().create({ type: 'project', repo: other, base: 'nope' })).rejects.toThrow(
      InvalidInput,
    );
  });

  it('creates a new project with the structure of the profile, its CI and its conventions', async () => {
    const repo = join(root, 'brand-new');
    const { scenario, created, conventions } = await service().create({
      type: 'project',
      repo,
      newProject: true,
    });
    expect(created).toBe(true);
    expect(scenario).toMatchObject({ folder: repo, baseBranch: 'main', profile: 'software' });
    expect((await stat(join(repo, '.github', 'workflows', 'ci.yml'))).isFile()).toBe(true);
    expect(await readFile(join(repo, 'CHANGELOG.md'), 'utf8')).toContain('## [Unreleased]');
    expect(conventions).toMatchObject({
      source: 'profile',
      changelog: { format: 'keep-a-changelog', file: 'CHANGELOG.md' },
      commit: { style: 'conventional' },
      ci: 'github-actions',
    });
    expect(parseConventions((await store.scenarios.get(scenario.id))?.conventions)).toEqual(
      conventions,
    );
    expect((await testGit(repo, 'status', '--porcelain')).trim()).toBe('');
  });

  it('refuses a new project in a folder that already has files', async () => {
    const repo = await importedRepo('main');
    await expect(service().create({ type: 'project', repo, newProject: true })).rejects.toThrow(
      InvalidInput,
    );
  });
});
