// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import type { EmptyInitMode, InitMode } from '../config.js';
import { NeedsInit } from '../project/init.js';
import { buildDaemonRegistries } from '../registries.js';
import { ScenarioService } from './service.js';

afterAll(disposeTestGitIsolation);

let root: string;
let store: InMemoryStore;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'otheater-service-init-')));
  store = new InMemoryStore({ clock: new FakeClock() });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(
  mode: InitMode = 'ask',
  message = 'chore: initial commit',
  emptyMode: EmptyInitMode = 'ask',
): ScenarioService {
  return new ScenarioService({
    store,
    vcs: defaultVcs(),
    registries: buildDaemonRegistries(),
    scenariosDir: join(root, 'scenarios'),
    initSettings: () => ({ mode, emptyMode, message }),
  });
}

/** A folder with files and no repository; `ignored.log` is in the `.gitignore`. */
async function folderWithFiles(name = 'files'): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder);
  await writeFile(join(folder, 'a.txt'), 'a\n');
  await writeFile(join(folder, 'ignored.log'), 'x\n');
  await writeFile(join(folder, '.gitignore'), 'ignored.log\n');
  return folder;
}

async function trackedFiles(folder: string): Promise<string[]> {
  const out = await testGit(folder, 'ls-tree', '-r', '--name-only', 'HEAD');
  return out === '' ? [] : out.split('\n').sort();
}

async function initEvents() {
  return (await store.events.readFrom(0, 200)).filter(
    (event) => event.type === 'project.repo_initialized',
  );
}

describe('opening a project on a folder that is not a repository (N332)', () => {
  it('commit_all: git init and a first commit with every file, the .gitignore respected', async () => {
    const folder = await folderWithFiles();
    const { scenario, created } = await service().create({
      type: 'project',
      repo: folder,
      init: 'commit_all',
    });
    expect(created).toBe(true);
    expect(scenario.baseBranch).toBe('main');
    expect(await trackedFiles(folder)).toEqual(['.gitignore', 'a.txt']);
    expect(await testGit(folder, 'log', '--format=%s')).toBe('chore: initial commit');
    expect(await testGit(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
    const events = await initEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      scenarioId: scenario.id,
      folder,
      mode: 'commit_all',
      branch: 'main',
      head: await testGit(folder, 'rev-parse', 'HEAD'),
    });
  });

  it('empty_commit: git init and an empty first commit, the files stay out', async () => {
    const folder = await folderWithFiles();
    await service().create({ type: 'project', repo: folder, init: 'empty_commit' });
    expect(await trackedFiles(folder)).toEqual([]);
    expect(await testGit(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect((await initEvents())[0]?.payload).toMatchObject({ mode: 'empty_commit' });
  });

  it('empty_repo: creates a missing folder, and initializes an empty one', async () => {
    const missing = join(root, 'deep', 'new');
    const first = await service().create({ type: 'project', repo: missing, init: 'empty_repo' });
    expect((await stat(missing)).isDirectory()).toBe(true);
    expect(await trackedFiles(missing)).toEqual([]);
    expect(first.scenario.baseBranch).toBe('main');

    const empty = join(root, 'empty');
    await mkdir(empty);
    await service().create({ type: 'project', repo: empty, init: 'empty_repo', base: 'trunk' });
    expect(await testGit(empty, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    expect(await initEvents()).toHaveLength(2);
  });

  it('uses projects.init.message for the first commit', async () => {
    const folder = await folderWithFiles();
    await service('ask', 'chore: start here').create({
      type: 'project',
      repo: folder,
      init: 'commit_all',
    });
    expect(await testGit(folder, 'log', '--format=%s')).toBe('chore: start here');
  });

  it('files without init follow projects.init.mode: commit_all and empty_commit', async () => {
    const all = await folderWithFiles('all');
    await service('commit_all').create({ type: 'project', repo: all });
    expect(await trackedFiles(all)).toEqual(['.gitignore', 'a.txt']);

    const empty = await folderWithFiles('empty-commit');
    await service('empty_commit').create({ type: 'project', repo: empty });
    expect(await trackedFiles(empty)).toEqual([]);
  });

  it('files without init and mode ask: needs_init, and nothing is created', async () => {
    const folder = await folderWithFiles();
    const error = await service('ask')
      .create({ type: 'project', repo: folder })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(NeedsInit);
    expect((error as NeedsInit).details).toEqual({
      reason: 'needs_init',
      choices: ['commit_all', 'empty_commit'],
      state: 'files',
    });
    await expect(stat(join(folder, '.git'))).rejects.toThrow();
    expect(await store.scenarios.list({})).toHaveLength(0);
  });

  it('files without init and mode refuse: refuses as before, and an explicit init too', async () => {
    const folder = await folderWithFiles();
    await expect(service('refuse').create({ type: 'project', repo: folder })).rejects.toThrow(
      /refuse/,
    );
    await expect(
      service('refuse').create({ type: 'project', repo: folder, init: 'commit_all' }),
    ).rejects.toThrow(/refuse/);
    await expect(stat(join(folder, '.git'))).rejects.toThrow();
  });

  it('empty_repo on a folder with files is invalid', async () => {
    const folder = await folderWithFiles();
    await expect(
      service('commit_all').create({ type: 'project', repo: folder, init: 'empty_repo' }),
    ).rejects.toBeInstanceOf(InvalidInput);
    await expect(stat(join(folder, '.git'))).rejects.toThrow();
  });

  it('an empty or missing folder follows projects.init.empty_mode, whatever projects.init.mode is', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    for (const mode of ['ask', 'commit_all', 'empty_commit', 'refuse'] as const) {
      const error = await service(mode)
        .create({ type: 'project', repo: empty })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(NeedsInit);
    }
    await expect(stat(join(empty, '.git'))).rejects.toThrow();
  });

  it('empty_mode ask: needs_init with the choices and the state of the folder, nothing is created', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    const missing = join(root, 'nothing');
    for (const [folder, state] of [
      [empty, 'empty'],
      [missing, 'missing'],
    ] as const) {
      const error = await service('ask', undefined, 'ask')
        .create({ type: 'project', repo: folder })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(NeedsInit);
      expect((error as NeedsInit).details).toEqual({
        reason: 'needs_init',
        choices: ['new_project', 'empty_repo'],
        state,
      });
    }
    await expect(stat(join(empty, '.git'))).rejects.toThrow();
    await expect(stat(missing)).rejects.toThrow();
    expect(await store.scenarios.list({})).toHaveLength(0);
  });

  it('empty_mode software: an empty or missing folder gets the software model, as with newProject', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    const missing = join(root, 'nothing');
    for (const folder of [empty, missing]) {
      const { scenario, conventions } = await service('ask', undefined, 'software').create({
        type: 'project',
        repo: folder,
      });
      expect(scenario.baseBranch).toBe('main');
      expect(conventions).toBeDefined();
      expect(await trackedFiles(folder)).toContain('README.md');
      expect(await trackedFiles(folder)).toContain('CHANGELOG.md');
    }
    expect(await initEvents()).toHaveLength(0);
  });

  it('empty_mode empty_repo: git init and an empty first commit, with the event', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    const missing = join(root, 'nothing');
    const first = await service('ask', undefined, 'empty_repo').create({
      type: 'project',
      repo: missing,
    });
    expect(first.scenario.baseBranch).toBe('main');
    expect(await testGit(missing, 'rev-list', '--count', 'HEAD')).toBe('1');
    await service('ask', undefined, 'empty_repo').create({
      type: 'project',
      repo: empty,
      base: 'trunk',
    });
    expect(await testGit(empty, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
    expect(await trackedFiles(empty)).toEqual([]);
    const events = await initEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({ mode: 'empty_repo', folder: missing });
  });

  it('empty_mode refuse: refuses an empty or missing folder, naming the key', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    for (const folder of [empty, join(root, 'nothing')]) {
      await expect(
        service('commit_all', undefined, 'refuse').create({ type: 'project', repo: folder }),
      ).rejects.toThrow(/projects\.init\.empty_mode is "refuse"/);
    }
    await expect(stat(join(empty, '.git'))).rejects.toThrow();
    await expect(stat(join(root, 'nothing'))).rejects.toThrow();
    expect(await store.scenarios.list({})).toHaveLength(0);
  });

  it('an explicit init or newProject wins over empty_mode', async () => {
    const one = join(root, 'one');
    await mkdir(one);
    await service('ask', undefined, 'refuse').create({
      type: 'project',
      repo: one,
      init: 'empty_repo',
    });
    expect(await trackedFiles(one)).toEqual([]);
    const two = join(root, 'two');
    await service('ask', undefined, 'empty_repo').create({
      type: 'project',
      repo: two,
      newProject: true,
    });
    expect(await trackedFiles(two)).toContain('README.md');
    const three = join(root, 'three');
    await service('ask', undefined, 'ask').create({
      type: 'project',
      repo: three,
      init: 'empty_repo',
    });
    expect(await trackedFiles(three)).toEqual([]);
    const four = join(root, 'four');
    await service('ask', undefined, 'software').create({
      type: 'project',
      repo: four,
      init: 'empty_repo',
    });
    expect(await trackedFiles(four)).toEqual([]);
    expect(await initEvents()).toHaveLength(3);
  });

  it('empty_mode does not touch a folder with files nor a repository', async () => {
    const folder = await folderWithFiles();
    await expect(
      service('ask', undefined, 'software').create({ type: 'project', repo: folder }),
    ).rejects.toBeInstanceOf(NeedsInit);
    await expect(stat(join(folder, '.git'))).rejects.toThrow();
    const repo = join(root, 'repo');
    await mkdir(repo);
    await testGit(repo, 'init', '--quiet', '--initial-branch=main');
    await testGit(repo, 'commit', '--quiet', '--allow-empty', '-m', 'first');
    const head = await testGit(repo, 'rev-parse', 'HEAD');
    await service('ask', undefined, 'software').create({ type: 'project', repo });
    expect(await testGit(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('init on a repository is ignored, with a notice', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    await testGit(repo, 'init', '--quiet', '--initial-branch=main');
    await testGit(repo, 'commit', '--quiet', '--allow-empty', '-m', 'first');
    const head = await testGit(repo, 'rev-parse', 'HEAD');
    const { scenario } = await service('refuse').create({
      type: 'project',
      repo,
      init: 'commit_all',
    });
    expect(await testGit(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await initEvents()).toHaveLength(0);
    const notices = (await store.events.readFrom(0, 200)).filter(
      (event) => event.type === 'scenario.notice',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      scenarioId: scenario.id,
      kind: 'init_ignored',
    });
  });

  it('init together with newProject is invalid', async () => {
    const folder = join(root, 'born');
    await expect(
      service().create({ type: 'project', repo: folder, newProject: true, init: 'empty_repo' }),
    ).rejects.toThrow(/do not go together/);
    await expect(stat(folder)).rejects.toThrow();
  });

  it('opening the same folder again does not initialize or announce twice', async () => {
    const folder = await folderWithFiles();
    await service().create({ type: 'project', repo: folder, init: 'commit_all' });
    const again = await service().create({ type: 'project', repo: folder, init: 'commit_all' });
    expect(again.created).toBe(false);
    expect(await initEvents()).toHaveLength(1);
  });
});
