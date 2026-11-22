// SPDX-License-Identifier: MPL-2.0
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Conflict, InvalidInput, NotFound } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { PluginInstaller, originTextOf } from './install.js';
import {
  commitAll,
  git,
  isolatedEnv,
  makeGitRepo,
  manifestText,
  packNpmFixture,
  startFakeNpmRegistry,
  writePluginFolder,
  type FakeRegistry,
  type GitFixture,
  type NpmFixture,
} from './plugin-fixture.js';
import { PluginRegistry, pluginPaths } from './registry.js';
import { execRunner, type CommandRun, type CommandRunner } from './sources.js';

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('PluginInstaller', () => {
  let data: Awaited<ReturnType<typeof makeTempDataDir>>;
  let work: Awaited<ReturnType<typeof makeTempDataDir>>;
  let registry: PluginRegistry;
  let marker: string;
  let runs: CommandRun[];

  /** The real `npm` and `git`, recorded, with no network but the loopback registry. */
  const recording: CommandRunner = async (run) => {
    runs.push(run);
    return await execRunner(run);
  };

  const installer = (
    options: {
      sources?: readonly ('path' | 'npm' | 'git')[];
      env?: Record<string, string>;
      runner?: CommandRunner;
    } = {},
  ): PluginInstaller =>
    new PluginInstaller({
      registry,
      dataDir: data.dir,
      sources: options.sources ?? ['path', 'npm', 'git'],
      timeoutMs: 120_000,
      env: options.env ?? isolatedEnv(work.dir),
      cwd: work.dir,
      runner: options.runner ?? recording,
    });

  beforeEach(async () => {
    data = await makeTempDataDir();
    work = await makeTempDataDir();
    marker = join(work.dir, 'MARKER');
    runs = [];
    registry = await PluginRegistry.open({
      dataDir: data.dir,
      clock: new FakeClock(),
      logger: createSilentLogger(),
    });
  });
  afterEach(async () => {
    registry.close();
    await data.dispose();
    await work.dispose();
  });

  describe('from a local folder', () => {
    it('keeps the path and the hash, copies nothing, and installs off', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      const result = await installer().install(folder);

      expect(result).toMatchObject({ id: 'demo-db', version: '1.0.0', dir: folder });
      expect(result.origin).toEqual({ kind: 'path', path: folder });
      expect(result.outcome.kind).toBe('installed');
      expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      // Nothing was copied into the data folder, and the plugin is on nowhere.
      expect(await exists(join(pluginPaths(data.dir).dir, 'demo-db'))).toBe(false);
      expect(registry.list().map((view) => view.id)).toEqual(['demo-db']);
      expect(registry.activeProjects()).toEqual([]);
      expect(runs).toEqual([]);
    });

    it('takes a relative folder against the working folder', async () => {
      await writePluginFolder(join(work.dir, 'rel'));
      const result = await installer().install('./rel');
      expect(result.dir).toBe(join(work.dir, 'rel'));
    });

    it('refuses an invalid manifest with the lines of the P3 validator, and registers nothing', async () => {
      const folder = await writePluginFolder(join(work.dir, 'bad'));
      await writeFile(
        join(folder, 'plugin.yaml'),
        manifestText().replace('effects: read', 'effects: delete_everything'),
      );
      const error = await installer()
        .install(folder)
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(error).toBeInstanceOf(InvalidInput);
      expect((error as Error).message).toContain('Invalid plugin.yaml');
      expect((error as Error).message).toContain('tools[0].effects');
      expect(registry.list()).toEqual([]);
    });

    it('refuses a folder with no manifest and a path that is not a folder', async () => {
      await mkdir(join(work.dir, 'empty'));
      await writeFile(join(work.dir, 'file.txt'), 'x');
      await expect(installer().install(join(work.dir, 'empty'))).rejects.toBeInstanceOf(
        InvalidInput,
      );
      await expect(installer().install(join(work.dir, 'file.txt'))).rejects.toBeInstanceOf(
        InvalidInput,
      );
      await expect(installer().install(join(work.dir, 'missing'))).rejects.toBeInstanceOf(
        InvalidInput,
      );
    });

    it('refuses a second install of the same id, and update replaces it', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      await installer().install(folder);
      await expect(installer().install(folder)).rejects.toBeInstanceOf(Conflict);
      const updated = await installer().update('demo-db');
      expect(updated.outcome.kind).toBe('updated');
      await expect(installer().update('nope')).rejects.toBeInstanceOf(NotFound);
    });

    it('update with a changed manifest leaves the plugin off until enable approves it again', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      const tool = installer();
      await tool.install(folder);
      await registry.enable('demo-db', 'p1');
      expect(registry.activeFor('p1')).toHaveLength(1);

      await writePluginFolder(folder, { variant: 'changed', version: '1.1.0' });
      const result = await tool.update('demo-db');

      expect(result.outcome.needsApproval).toEqual(['p1']);
      expect(registry.activeFor('p1')).toEqual([]);
      await registry.enable('demo-db', 'p1');
      expect(registry.activeFor('p1')[0]?.version).toBe('1.1.0');
    });

    it('update refuses a folder whose manifest has another id', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      await installer().install(folder);
      const other = await writePluginFolder(join(work.dir, 'other'), { id: 'other-db' });
      await expect(installer().update('demo-db', other)).rejects.toBeInstanceOf(InvalidInput);
      expect(registry.list().map((view) => view.id)).toEqual(['demo-db']);
    });

    it('remove forgets the plugin but never deletes the local folder', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      await installer().install(folder);
      await registry.enable('demo-db', 'p1');
      const removed = await installer().remove('demo-db');
      expect(removed.folderDeleted).toBe(false);
      expect(await exists(join(folder, 'plugin.yaml'))).toBe(true);
      expect(registry.list()).toEqual([]);
      await expect(installer().remove('demo-db')).rejects.toBeInstanceOf(NotFound);
    });

    it('honours plugins.install.sources', async () => {
      const folder = await writePluginFolder(join(work.dir, 'demo-db'));
      await expect(installer({ sources: ['npm', 'git'] }).install(folder)).rejects.toThrow(
        /"path" is off/,
      );
      await expect(installer({ sources: [] }).install(folder)).rejects.toBeInstanceOf(InvalidInput);
      await expect(installer({ sources: ['path'] }).install('npm:demo-db@1.0.0')).rejects.toThrow(
        /"npm" is off/,
      );
      await expect(
        installer({ sources: ['path'] }).install('git:file:///nowhere#main'),
      ).rejects.toThrow(/"git" is off/);
      expect(runs).toEqual([]);
    });
  });

  describe('from npm', { timeout: 90_000 }, () => {
    let fixture: NpmFixture;
    let fixtureV2: NpmFixture;
    let fixtureChanged: NpmFixture;
    let fixtureBadManifest: NpmFixture;
    let server: FakeRegistry;
    let packRoot: string;
    let packMarker: string;

    beforeAll(async () => {
      const root = await makeTempDataDir();
      packRoot = root.dir;
      packMarker = join(root.dir, 'MARKER');
      const marker = packMarker;
      fixture = await packNpmFixture(root.dir, { name: 'demo-db', marker });
      fixtureV2 = await packNpmFixture(root.dir, {
        name: 'demo-db',
        version: '1.1.0',
        marker,
      });
      fixtureChanged = await packNpmFixture(root.dir, {
        name: 'demo-db',
        version: '1.2.0',
        marker,
        variant: 'changed',
      });
      fixtureBadManifest = await packNpmFixture(root.dir, {
        name: 'skewed',
        id: 'skewed',
        version: '3.0.1',
        packageVersion: '3.0.0',
        marker,
      });
      server = await startFakeNpmRegistry([fixture, fixtureV2, fixtureChanged, fixtureBadManifest]);
    });
    afterAll(async () => {
      await server.close();
      await (await import('node:fs/promises')).rm(packRoot, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await (await import('node:fs/promises')).rm(packMarker, { force: true });
    });

    const npmEnv = (): Record<string, string> =>
      isolatedEnv(work.dir, { npm_config_registry: server.url });

    it('installs the tarball into <data>/plugins/<id>/<version>/ and keeps version and package hash', async () => {
      const result = await installer({ env: npmEnv() }).install('npm:demo-db@1.0.0');

      const root = join(pluginPaths(data.dir).dir, 'demo-db', '1.0.0');
      expect(result.dir).toBe(join(root, 'node_modules', 'demo-db'));
      expect(await readFile(join(result.dir, 'plugin.yaml'), 'utf8')).toBe(manifestText());
      expect(result.origin).toEqual({
        kind: 'npm',
        name: 'demo-db',
        version: '1.0.0',
        integrity: fixture.integrity,
      });
      expect(registry.get('demo-db')?.origin).toEqual(result.origin);
      expect(registry.activeProjects()).toEqual([]);
      // The staging area is gone, and only the loopback registry was asked.
      expect(await readdir(pluginPaths(data.dir).staging)).toEqual([]);
      expect(server.requests.length).toBeGreaterThan(0);
    });

    it('does not run the preinstall and postinstall scripts of the package', async () => {
      await installer({ env: npmEnv() }).install('npm:demo-db@1.0.0');
      expect(await exists(packMarker)).toBe(false);
      // The same marker in the folder of the package says the scripts were in the tarball.
      const manifest = JSON.parse(
        await readFile(
          join(
            pluginPaths(data.dir).dir,
            'demo-db',
            '1.0.0',
            'node_modules',
            'demo-db',
            'package.json',
          ),
          'utf8',
        ),
      ) as { scripts: Record<string, string> };
      expect(Object.keys(manifest.scripts)).toEqual(['preinstall', 'postinstall']);
      const npmRun = runs.find((run) => run.file === 'npm');
      expect(npmRun?.args).toContain('--ignore-scripts');
    });

    it('the control: the same package WITH scripts allowed writes the marker', async () => {
      // Proves the marker detects a script, so its absence above means something.
      const control = await installer({
        env: npmEnv(),
        runner: async (run) =>
          await execRunner({
            ...run,
            args: run.args.filter((arg) => arg !== '--ignore-scripts'),
          }),
      }).install('npm:demo-db@1.0.0');
      expect(control.id).toBe('demo-db');
      expect(await exists(packMarker)).toBe(true);
    });

    it('starts npm with a short environment: no key or token of the daemon reaches it', async () => {
      const env = { ...npmEnv(), OPENAI_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_secret' };
      await installer({ env }).install('npm:demo-db@1.0.0');
      const npmRun = runs.find((run) => run.file === 'npm');
      expect(npmRun?.env.OPENAI_API_KEY).toBeUndefined();
      expect(npmRun?.env.GITHUB_TOKEN).toBeUndefined();
      expect(npmRun?.env.npm_config_registry).toBe(server.url);
    });

    it('refuses a package whose manifest version is not the package version', async () => {
      await expect(installer({ env: npmEnv() }).install('npm:skewed@3.0.0')).rejects.toThrow(
        /3\.0\.1/,
      );
      expect(registry.list()).toEqual([]);
      expect(await readdir(pluginPaths(data.dir).staging)).toEqual([]);
    });

    it('update to another version moves the folder, drops the old one, and turns the plugin off until approved', async () => {
      const tool = installer({ env: npmEnv() });
      await tool.install('npm:demo-db@1.0.0');
      await registry.enable('demo-db', 'p1');

      // Any byte of plugin.yaml that changes (here the version line) asks for a new approval.
      const bump = await tool.update('demo-db', 'npm:demo-db@1.1.0');
      expect(bump.outcome.needsApproval).toEqual(['p1']);
      expect(registry.activeFor('p1')).toEqual([]);
      expect(await exists(join(pluginPaths(data.dir).dir, 'demo-db', '1.0.0'))).toBe(false);
      await registry.enable('demo-db', 'p1');
      expect(registry.activeFor('p1')[0]?.version).toBe('1.1.0');

      const changed = await tool.update('demo-db', 'npm:demo-db@1.2.0');
      expect(changed.outcome.needsApproval).toEqual(['p1']);
      expect(registry.activeFor('p1')).toEqual([]);
    });

    it('remove deletes the folder it owns', async () => {
      await installer({ env: npmEnv() }).install('npm:demo-db@1.0.0');
      const removed = await installer().remove('demo-db');
      expect(removed.folderDeleted).toBe(true);
      expect(await exists(join(pluginPaths(data.dir).dir, 'demo-db', '1.0.0'))).toBe(false);
    });

    it('a package that does not exist fails and leaves nothing behind', async () => {
      await expect(
        installer({ env: npmEnv() }).install('npm:nope-pkg@9.9.9'),
      ).rejects.toBeInstanceOf(InvalidInput);
      expect(registry.list()).toEqual([]);
      expect(await readdir(pluginPaths(data.dir).staging)).toEqual([]);
    });
  });

  describe('from git', { timeout: 30_000 }, () => {
    let repo: GitFixture;

    beforeEach(async () => {
      repo = await makeGitRepo(work.dir, 'repo', { marker });
      // The hooks of the fixture ran at its own commit: clear what that wrote.
      await writeFile(marker, '');
      await (await import('node:fs/promises')).rm(marker, { force: true });
    });

    it('clones a local file:// repository pinned to the commit, with no .git', async () => {
      const result = await installer().install(`git:${repo.url}#main`);

      expect(result.origin).toEqual({
        kind: 'git',
        url: repo.url,
        ref: 'main',
        commit: repo.commit,
      });
      const root = join(pluginPaths(data.dir).dir, 'demo-db', '1.0.0');
      expect(result.dir).toBe(join(root, '.'));
      expect(await exists(join(root, 'plugin.yaml'))).toBe(true);
      expect(await exists(join(root, '.git'))).toBe(false);
      expect(registry.activeProjects()).toEqual([]);
    });

    it('does not run the hooks of the repository, nor those of a template', async () => {
      const template = join(work.dir, 'template');
      await mkdir(join(template, 'hooks'), { recursive: true });
      const hook = join(template, 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\necho hook > ${JSON.stringify(marker)}\n`, { mode: 0o755 });

      // The control: a plain clone with that template and a checkout runs the hook.
      const controlDir = join(work.dir, 'control');
      await git(work.dir, work.dir, [
        'clone',
        '--quiet',
        '--no-checkout',
        `--template=${template}`,
        repo.url,
        controlDir,
      ]);
      await git(controlDir, work.dir, ['checkout', '--quiet', 'main']);
      expect(await exists(marker)).toBe(true);
      await (await import('node:fs/promises')).rm(marker, { force: true });

      // The install, with the template offered in the environment, does not.
      const env = isolatedEnv(work.dir, { GIT_TEMPLATE_DIR: template });
      await installer({ env }).install(`git:${repo.url}#main`);
      expect(await exists(marker)).toBe(false);

      const clone = runs.find((run) => run.args.includes('clone'));
      expect(clone?.args).toContain('--template=');
      expect(clone?.args.join(' ')).toContain('core.hooksPath=');
      expect(clone?.args.join(' ')).toContain('protocol.ext.allow=never');
      expect(clone?.env.GIT_TEMPLATE_DIR).toBeUndefined();
      expect(clone?.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(clone?.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    });

    it('without #ref takes the default branch; a tag and a commit also work', async () => {
      await git(repo.dir, work.dir, ['tag', 'v1']);
      expect((await installer().install(`git:${repo.url}`)).origin).toMatchObject({
        ref: 'HEAD',
        commit: repo.commit,
      });
      await installer().remove('demo-db');
      expect((await installer().install(`git:${repo.url}#v1`)).origin).toMatchObject({
        commit: repo.commit,
      });
      await installer().remove('demo-db');
      expect((await installer().install(`git:${repo.url}#${repo.commit}`)).origin).toMatchObject({
        commit: repo.commit,
      });
    });

    it('refuses a ref the repository does not have', async () => {
      await expect(installer().install(`git:${repo.url}#nope`)).rejects.toBeInstanceOf(
        InvalidInput,
      );
      expect(registry.list()).toEqual([]);
      expect(await readdir(pluginPaths(data.dir).staging)).toEqual([]);
    });

    it('update re-reads the ref: a new commit with another manifest turns the plugin off', async () => {
      const tool = installer();
      await tool.install(`git:${repo.url}#main`);
      await registry.enable('demo-db', 'p1');

      await writeFile(join(repo.dir, 'plugin.yaml'), manifestText({ variant: 'changed' }));
      const commit = await commitAll(repo, work.dir, 'more tools');
      const result = await tool.update('demo-db');

      expect(result.origin).toMatchObject({ kind: 'git', commit });
      expect(result.outcome.needsApproval).toEqual(['p1']);
      expect(registry.activeFor('p1')).toEqual([]);
      expect(originTextOf(result.origin)).toBe(`git:${repo.url}#main`);
    });

    it('an invalid manifest in the repository is refused and nothing stays', async () => {
      await writeFile(join(repo.dir, 'plugin.yaml'), 'manifest_version: 1\nid: demo-db\n');
      await commitAll(repo, work.dir, 'break it');
      await expect(installer().install(`git:${repo.url}#main`)).rejects.toThrow(
        /Invalid plugin\.yaml/,
      );
      expect(registry.list()).toEqual([]);
      expect(await exists(join(pluginPaths(data.dir).dir, 'demo-db'))).toBe(false);
    });

    it('refuses URLs that run a command or are not encrypted, before running git', async () => {
      for (const origin of ['git:ext::sh -c touch#x', 'git:http://example.com/a.git#main']) {
        await expect(installer().install(origin)).rejects.toBeInstanceOf(InvalidInput);
      }
      expect(runs).toEqual([]);
    });
  });
});
