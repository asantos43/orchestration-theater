// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterUnavailable, Conflict, InvalidInput, NotFound } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKFLOWS_SETTINGS } from '../config.js';
import { WorkflowLibrary } from '../library.js';
import { DEFAULT_WORKFLOW_PACKAGES_SETTINGS, type WorkflowPackagesSettings } from './config.js';
import {
  decidePolicy,
  WorkflowPackageInstaller,
  type PackagePreview,
  type WorkflowPackageInstallerDeps,
} from './install.js';
import {
  fileUrl,
  generateTestKey,
  gitCommitAll,
  gitInit,
  removeTempFolders,
  signSshsig,
  tempFolder,
  workflowYaml,
  writePackageFolder,
  type TestKey,
} from './packages.test-support.js';
import { WorkflowPackageRegistry, workflowPackagePaths } from './registry.js';
import { parseTrustedKey, type KeygenRunner, type SignatureCheck } from './sshsig.js';

afterEach(removeTempFolders);

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

interface World {
  readonly store: InMemoryStore;
  readonly library: WorkflowLibrary;
  readonly registry: WorkflowPackageRegistry;
  readonly installer: WorkflowPackageInstaller;
  readonly staging: string;
  readonly errors: string[];
  settings: WorkflowPackagesSettings;
}

async function world(
  settings: Partial<WorkflowPackagesSettings> = {},
  extra: Partial<WorkflowPackageInstallerDeps> = {},
): Promise<World> {
  const store = new InMemoryStore({ clock: new FakeClock() });
  const library = new WorkflowLibrary({ store, settings: () => DEFAULT_WORKFLOWS_SETTINGS });
  const paths = workflowPackagePaths(await tempFolder());
  const registry = new WorkflowPackageRegistry(paths.file);
  const errors: string[] = [];
  const state = { settings: { ...DEFAULT_WORKFLOW_PACKAGES_SETTINGS, ...settings } };
  const installer = new WorkflowPackageInstaller({
    library,
    registry,
    settings: () => state.settings,
    stagingDir: paths.staging,
    events: store.events,
    logger: { error: (_fields, message) => errors.push(message) },
    clock: new FakeClock(),
    env: { PATH: process.env.PATH },
    cwd: await tempFolder(),
    ...extra,
  });
  return {
    store,
    library,
    registry,
    installer,
    staging: paths.staging,
    errors,
    get settings() {
      return state.settings;
    },
    set settings(value) {
      state.settings = value;
    },
  };
}

async function eventsOf(
  store: InMemoryStore,
  type: string,
): Promise<readonly Record<string, unknown>[]> {
  const all = await store.events.readFrom(0, 1000);
  return all
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

interface MakePackage {
  readonly id?: string;
  readonly version?: string;
  readonly workflows?: readonly { id: string; version: string; requiresTools?: string[] }[];
  readonly signWith?: TestKey;
  readonly namespace?: string;
}

/** A package folder with one workflow (or the ones asked for); returns the folder. */
async function makePackage(options: MakePackage = {}): Promise<string> {
  const root = await tempFolder();
  const version = options.version ?? '1.0.0';
  const workflows = options.workflows ?? [{ id: 'review', version }];
  await writePackageFolder(root, {
    id: options.id ?? 'review-kit',
    version,
    description: 'Review workflows',
    files: workflows.map((workflow) => ({
      path: `workflows/${workflow.id}.yaml`,
      text: workflowYaml(workflow.id, workflow.version, {
        ...(workflow.requiresTools === undefined ? {} : { requiresTools: workflow.requiresTools }),
      }),
    })),
    ...(options.signWith === undefined ? {} : { signWith: options.signWith }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
  });
  return root;
}

const yes = (): boolean => true;
const no = (): boolean => false;

async function versionsOf(w: World, id = 'review'): Promise<string[]> {
  return (await w.library.list({ workflowId: id })).map(
    (record) => `${record.version}:${record.state}`,
  );
}

describe('the signature policy', () => {
  const check = (state: SignatureCheck['state']): SignatureCheck => ({
    state,
    signer: null,
    detail: state,
  });
  const policy = (
    signature: 'verify_if_present' | 'require' | 'off',
    unsigned: 'confirm' | 'reject',
    state: SignatureCheck['state'],
  ) => decidePolicy({ signature, unsigned }, check(state));

  it('lets verified and skipped through without a reason to confirm', () => {
    for (const mode of ['verify_if_present', 'require', 'off'] as const) {
      expect(policy(mode, 'reject', 'verified')).toEqual({ kind: 'ready', confirm: [] });
    }
    expect(policy('off', 'reject', 'skipped')).toEqual({ kind: 'ready', confirm: [] });
  });

  it('always refuses an invalid signature', () => {
    for (const mode of ['verify_if_present', 'require'] as const) {
      expect(policy(mode, 'confirm', 'invalid')).toMatchObject({
        kind: 'refused',
        reason: 'invalid',
      });
    }
  });

  it('asks for what is not verified when unsigned is confirm, refuses it when reject', () => {
    expect(policy('verify_if_present', 'confirm', 'absent')).toEqual({
      kind: 'ready',
      confirm: ['unsigned'],
    });
    expect(policy('verify_if_present', 'confirm', 'unverified')).toEqual({
      kind: 'ready',
      confirm: ['unsigned'],
    });
    expect(policy('verify_if_present', 'reject', 'absent')).toMatchObject({
      kind: 'refused',
      reason: 'not_signed',
    });
    expect(policy('verify_if_present', 'reject', 'unverified')).toMatchObject({
      kind: 'refused',
      reason: 'not_verified',
    });
  });

  it('refuses what is not verified when signature is require, whatever unsigned says', () => {
    expect(policy('require', 'confirm', 'absent')).toMatchObject({ reason: 'not_signed' });
    expect(policy('require', 'confirm', 'unverified')).toMatchObject({ reason: 'not_verified' });
  });
});

describe('installing a folder with no signature', () => {
  it('shows the preview, and installs it once the Producer approves', async () => {
    const w = await world();
    const folder = await makePackage({ workflows: [{ id: 'review', version: '1.0.0' }] });
    const seen: PackagePreview[] = [];
    const result = await w.installer.install(folder, {
      approve: (preview) => {
        seen.push(preview);
        return true;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      packageId: 'review-kit',
      version: '1.0.0',
      description: 'Review workflows',
      origin: { kind: 'file', path: folder },
      workflows: [{ id: 'review', version: '1.0.0', path: 'workflows/review.yaml' }],
      previousVersion: null,
      signature: { state: 'absent' },
      outcome: { kind: 'ready', confirm: ['unsigned'] },
    });
    expect(seen[0]?.permissions.publicWrites).toEqual(['comment']);
    expect(seen[0]?.newPermissions).toContain('public_write:comment');
    expect(result.status).toBe('installed');
    expect(result.workflows).toEqual([{ id: 'review', version: '1.0.0', active: true }]);
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
    expect((await w.library.get('review', '1.0.0'))?.packageId).toBe('review-kit');
    expect(await w.registry.get('review-kit')).toMatchObject({
      version: '1.0.0',
      signature: 'absent',
      confirmedUnsigned: true,
      workflows: ['review@1.0.0'],
      origin: { kind: 'file', path: folder },
    });
    expect(await eventsOf(w.store, 'workflow.package.installed')).toEqual([
      expect.objectContaining({
        packageId: 'review-kit',
        version: '1.0.0',
        previousVersion: null,
        signature: 'absent',
        confirmedUnsigned: true,
        workflows: ['review@1.0.0'],
      }),
    ]);
  });

  it('installs nothing when the Producer does not approve', async () => {
    const w = await world();
    await expect(w.installer.install(await makePackage(), { approve: no })).rejects.toThrow(
      /was not approved/,
    );
    expect(await w.library.list()).toEqual([]);
    expect(await w.registry.list()).toEqual([]);
    expect(await eventsOf(w.store, 'workflow.package.installed')).toEqual([]);
  });

  it('refuses it with `unsigned: reject`, writes the event and never asks', async () => {
    const w = await world({ unsigned: 'reject' });
    const approve = vi.fn(yes);
    await expect(w.installer.install(await makePackage(), { approve })).rejects.toThrow(
      InvalidInput,
    );
    expect(approve).not.toHaveBeenCalled();
    expect(await w.library.list()).toEqual([]);
    expect(await eventsOf(w.store, 'workflow.package.signature_failed')).toEqual([
      expect.objectContaining({
        packageId: 'review-kit',
        mode: 'verify_if_present',
        unsigned: 'reject',
        reason: 'not_signed',
      }),
    ]);
  });

  it('refuses it with `signature: require`, even with `unsigned: confirm`', async () => {
    const w = await world({ signature: 'require', unsigned: 'confirm' });
    await expect(w.installer.install(await makePackage(), { approve: yes })).rejects.toThrow(
      /signature is require/,
    );
    expect(await eventsOf(w.store, 'workflow.package.signature_failed')).toEqual([
      expect.objectContaining({ mode: 'require', reason: 'not_signed' }),
    ]);
  });

  it('does not look at signatures with `signature: off`', async () => {
    const w = await world({ signature: 'off' });
    const folder = await makePackage();
    await writeFile(join(folder, 'package.yaml.sshsig'), 'garbage');
    const approve = vi.fn((preview: PackagePreview) => preview.outcome.kind === 'ready');
    const result = await w.installer.install(folder, { approve });
    expect(result.preview.signature.state).toBe('skipped');
    expect(result.preview.outcome).toEqual({ kind: 'ready', confirm: [] });
    expect(await w.registry.get('review-kit')).toMatchObject({ confirmedUnsigned: false });
  });

  it('previews without saving or writing an event', async () => {
    const w = await world();
    const preview = await w.installer.preview(await makePackage());
    expect(preview.packageId).toBe('review-kit');
    expect(await w.library.list()).toEqual([]);
    expect(await w.registry.list()).toEqual([]);
    expect((await w.store.events.readFrom(0, 100)).length).toBe(0);
  });
});

describe.skipIf(!hasSshKeygen())('acceptance: signatures checked with ssh-keygen -Y verify', () => {
  it('installs a package that a trusted key signed, without needing a confirmation', async () => {
    const key = generateTestKey();
    const w = await world({ trusted_keys: [key.publicLine], unsigned: 'reject' });
    const result = await w.installer.install(await makePackage({ signWith: key }), {
      approve: yes,
    });
    expect(result.preview.signature).toMatchObject({
      state: 'verified',
      signer: parseTrustedKey(key.publicLine).fingerprint,
    });
    expect(result.preview.outcome).toEqual({ kind: 'ready', confirm: [] });
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
    expect(await w.registry.get('review-kit')).toMatchObject({
      signature: 'verified',
      confirmedUnsigned: false,
    });
  });

  it('refuses an invalid signature, even when the Producer would approve', async () => {
    const key = generateTestKey();
    const w = await world({ trusted_keys: [key.publicLine], unsigned: 'confirm' });
    const folder = await makePackage({ signWith: key });
    // The manifest changes after it was signed: the signature no longer matches it.
    const manifest = join(folder, 'package.yaml');
    const { readFile } = await import('node:fs/promises');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}# edited\n`);
    const approve = vi.fn(yes);
    await expect(w.installer.install(folder, { approve })).rejects.toThrow(/does not accept/);
    expect(approve).not.toHaveBeenCalled();
    expect(await w.library.list()).toEqual([]);
    expect(await eventsOf(w.store, 'workflow.package.signature_failed')).toEqual([
      expect.objectContaining({
        reason: 'invalid',
        unsigned: 'confirm',
        mode: 'verify_if_present',
      }),
    ]);
  });

  it('refuses a signature made for another namespace', async () => {
    const key = generateTestKey();
    const w = await world({ trusted_keys: [key.publicLine] });
    const folder = await makePackage({ signWith: key, namespace: 'otheater-release' });
    await expect(w.installer.install(folder, { approve: yes })).rejects.toThrow(/namespace/);
    expect(await eventsOf(w.store, 'workflow.package.signature_failed')).toEqual([
      expect.objectContaining({ reason: 'invalid' }),
    ]);
  });

  it('treats a key that is not trusted as not verified: it asks, or refuses with `reject`', async () => {
    const signer = generateTestKey();
    const other = generateTestKey();
    const folder = await makePackage({ signWith: signer });

    const asks = await world({ trusted_keys: [other.publicLine], unsigned: 'confirm' });
    const preview = await asks.installer.preview(folder);
    expect(preview.signature.state).toBe('unverified');
    expect(preview.outcome).toEqual({ kind: 'ready', confirm: ['unsigned'] });
    await asks.installer.install(folder, { approve: yes });
    expect(await asks.registry.get('review-kit')).toMatchObject({
      signature: 'unverified',
      confirmedUnsigned: true,
    });

    const rejects = await world({ trusted_keys: [other.publicLine], unsigned: 'reject' });
    await expect(rejects.installer.install(folder, { approve: yes })).rejects.toThrow(InvalidInput);
    expect(await eventsOf(rejects.store, 'workflow.package.signature_failed')).toEqual([
      expect.objectContaining({ reason: 'not_verified', unsigned: 'reject' }),
    ]);
  });
});

describe('without ssh-keygen', () => {
  const missing: KeygenRunner = () => Promise.reject(new AdapterUnavailable('not found'));

  it('counts a signed package as not verified and follows `unsigned`', async () => {
    const key = generateTestKey();
    const folder = await makePackage({ signWith: key });
    const asks = await world(
      { trusted_keys: [key.publicLine], unsigned: 'confirm' },
      { keygenRunner: missing },
    );
    const preview = await asks.installer.preview(folder);
    expect(preview.signature.state).toBe('unverified');
    expect(preview.signature.detail).toMatch(/ssh-keygen is not available/);
    expect(preview.outcome).toEqual({ kind: 'ready', confirm: ['unsigned'] });
    await asks.installer.install(folder, { approve: yes });
    expect(await versionsOf(asks)).toEqual(['1.0.0:active']);

    const rejects = await world(
      { trusted_keys: [key.publicLine], unsigned: 'reject' },
      { keygenRunner: missing },
    );
    await expect(rejects.installer.install(folder, { approve: yes })).rejects.toThrow(InvalidInput);
    expect(await rejects.library.list()).toEqual([]);

    const requires = await world(
      { trusted_keys: [key.publicLine], signature: 'require' },
      { keygenRunner: missing },
    );
    await expect(requires.installer.install(folder, { approve: yes })).rejects.toThrow(
      /signature is require/,
    );
  });
});

describe('a package that is a git repository', () => {
  async function repoWithPackage(): Promise<{ root: string; first: string }> {
    const root = await tempFolder();
    await gitInit(root);
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      files: [{ path: 'workflows/review.yaml', text: workflowYaml('review', '1.0.0') }],
    });
    return { root, first: await gitCommitAll(root, 'one') };
  }

  it('pins a branch to the commit at the install, and a moved ref changes nothing installed', async () => {
    const { root, first } = await repoWithPackage();
    const w = await world();
    const origin = `git:${fileUrl(root)}#main`;
    const result = await w.installer.install(origin, { approve: yes });
    expect(result.preview.origin).toEqual({
      kind: 'git',
      url: fileUrl(root),
      ref: 'main',
      commit: first,
    });
    expect(await w.registry.get('review-kit')).toMatchObject({
      version: '1.0.0',
      origin: { kind: 'git', ref: 'main', commit: first },
    });

    // The branch moves at the remote: a new version of the package is published on `main`.
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.1.0',
      files: [{ path: 'workflows/review.yaml', text: workflowYaml('review', '1.1.0') }],
    });
    const second = await gitCommitAll(root, 'two');
    expect(second).not.toBe(first);

    // Nothing that is installed changed.
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
    expect(await w.registry.get('review-kit')).toMatchObject({
      version: '1.0.0',
      origin: { commit: first },
    });
    // Looking again is what resolves the ref again, and it is a new install that shows the change.
    const next = await w.installer.preview(origin);
    expect(next).toMatchObject({
      version: '1.1.0',
      previousVersion: '1.0.0',
      origin: { commit: second },
    });
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
  });

  it('installs what a commit holds when the ref is the commit', async () => {
    const { root, first } = await repoWithPackage();
    const w = await world();
    const result = await w.installer.install(`git:${fileUrl(root)}#${first}`, { approve: yes });
    expect(result.preview.origin).toMatchObject({ kind: 'git', commit: first });
  });

  it('is refused when `workflows.packages.sources` does not allow git, and for npm', async () => {
    const { root } = await repoWithPackage();
    const w = await world({ sources: ['file'] });
    await expect(w.installer.install(`git:${fileUrl(root)}`, { approve: yes })).rejects.toThrow(
      /does not allow git/,
    );
    const onlyGit = await world({ sources: ['git'] });
    await expect(onlyGit.installer.install(await makePackage(), { approve: yes })).rejects.toThrow(
      /does not allow file/,
    );
    await expect(
      onlyGit.installer.install('npm:some-package@1.0.0', { approve: yes }),
    ).rejects.toThrow(/not npm/);
  });
});

describe('a file that is a single workflow', () => {
  it('is installed as a package of its own', async () => {
    const folder = await tempFolder();
    const file = join(folder, 'review.yaml');
    const key = generateTestKey();
    const text = workflowYaml('review', '1.0.0');
    await writeFile(file, text);
    await writeFile(`${file}.sshsig`, signSshsig(Buffer.from(text), key));
    const w = await world({ trusted_keys: [key.publicLine] });
    const result = await w.installer.install(file, { approve: yes });
    expect(result.preview.packageId).toBe('review');
    expect(result.preview.signature.state).toBe(hasSshKeygen() ? 'verified' : 'unverified');
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
  });
});

describe('what is checked before anything is saved', () => {
  it('refuses the whole package when one workflow is not valid', async () => {
    const w = await world();
    const folder = await makePackage({
      workflows: [
        { id: 'a', version: '1.0.0' },
        { id: 'b', version: '1.0.0' },
      ],
    });
    await writeFile(join(folder, 'workflows/b.yaml'), 'not: a workflow\n');
    // The manifest hash no longer matches: the package is refused before it is validated.
    await expect(w.installer.install(folder, { approve: yes })).rejects.toThrow(InvalidInput);
    expect(await w.library.list()).toEqual([]);

    const bad = await tempFolder();
    await writePackageFolder(bad, {
      id: 'bad-kit',
      version: '1.0.0',
      files: [
        { path: 'a.yaml', text: workflowYaml('a', '1.0.0') },
        { path: 'b.yaml', text: 'id: b\nversion: 1.0.0\n' },
      ],
    });
    await expect(w.installer.install(bad, { approve: yes })).rejects.toThrow(/b\.yaml/);
    expect(await w.library.list()).toEqual([]);
    expect(await w.registry.list()).toEqual([]);
  });

  it('refuses a workflow that needs a tool that is not installed', async () => {
    const w = await world(
      {},
      { validateOptions: () => ({ installed: { tools: [], plugins: [] } }) },
    );
    const folder = await makePackage({
      workflows: [{ id: 'review', version: '1.0.0', requiresTools: ['lint'] }],
    });
    await expect(w.installer.install(folder, { approve: yes })).rejects.toThrow(/not valid/);
    expect(await w.library.list()).toEqual([]);
  });

  it('refuses the same workflow version twice in one package', async () => {
    const w = await world();
    const root = await tempFolder();
    await writePackageFolder(root, {
      id: 'dup-kit',
      version: '1.0.0',
      files: [
        { path: 'a.yaml', text: workflowYaml('review', '1.0.0') },
        { path: 'b.yaml', text: workflowYaml('review', '1.0.0') },
      ],
    });
    await expect(w.installer.install(root, { approve: yes })).rejects.toThrow(
      /already in the package/,
    );
  });

  it('shows the permissions, and an update that adds one asks again', async () => {
    const w = await world();
    await w.installer.install(await makePackage({ version: '1.0.0' }), { approve: yes });
    const update = await makePackage({
      version: '1.1.0',
      workflows: [{ id: 'review', version: '1.1.0', requiresTools: ['lint'] }],
    });
    const seen: PackagePreview[] = [];
    const result = await w.installer.install(update, {
      approve: (preview) => {
        seen.push(preview);
        return true;
      },
    });
    expect(seen[0]?.previousVersion).toBe('1.0.0');
    expect(seen[0]?.permissions.tools).toEqual(['lint']);
    expect(seen[0]?.newPermissions).toEqual(['tool:lint']);
    expect(seen[0]?.outcome).toEqual({
      kind: 'ready',
      confirm: ['unsigned', 'new_permissions'],
    });
    expect(result.status).toBe('updated');
    expect((await w.registry.get('review-kit'))?.permissions).toContain('tool:lint');
    expect(await eventsOf(w.store, 'workflow.package.installed')).toEqual([
      expect.anything(),
      expect.objectContaining({
        previousVersion: '1.0.0',
        newPermissions: ['tool:lint'],
      }),
    ]);
    // The same package again adds nothing new.
    const again = await w.installer.preview(update);
    expect(again.newPermissions).toEqual([]);
  });
});

describe('versions never change', () => {
  it('installing the same package again changes nothing and asks nothing', async () => {
    const w = await world();
    const folder = await makePackage();
    await w.installer.install(folder, { approve: yes });
    const approve = vi.fn(yes);
    const again = await w.installer.install(folder, { approve });
    expect(again.status).toBe('unchanged');
    expect(approve).not.toHaveBeenCalled();
    expect(await eventsOf(w.store, 'workflow.package.installed')).toHaveLength(1);
  });

  it('refuses the same version with other content, in the package and in the workflow', async () => {
    const w = await world();
    await w.installer.install(await makePackage(), { approve: yes });
    // Same package version, other description: other manifest.
    const root = await tempFolder();
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      description: 'Changed',
      files: [{ path: 'workflows/review.yaml', text: workflowYaml('review', '1.0.0') }],
    });
    await expect(w.installer.install(root, { approve: yes })).rejects.toThrow(Conflict);
    // Another package that brings review@1.0.0 with other content.
    const other = await tempFolder();
    await writePackageFolder(other, {
      id: 'other-kit',
      version: '1.0.0',
      files: [
        { path: 'review.yaml', text: workflowYaml('review', '1.0.0', { description: 'Other' }) },
      ],
    });
    await expect(w.installer.install(other, { approve: yes })).rejects.toThrow(/other content/);
    // Another package that brings the very same workflow: it does not belong to it.
    const same = await tempFolder();
    await writePackageFolder(same, {
      id: 'same-kit',
      version: '1.0.0',
      files: [{ path: 'review.yaml', text: workflowYaml('review', '1.0.0') }],
    });
    await expect(w.installer.install(same, { approve: yes })).rejects.toThrow(
      /does not belong to the package same-kit/,
    );
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
  });
});

describe('workflows.packages.activate', () => {
  async function seed(w: World): Promise<void> {
    await w.library.install(JSON.parse(workflowYaml('review', '0.9.0')), { source: 'user' });
  }

  it('`when_none` keeps the version that is active and activates a workflow with none', async () => {
    const w = await world({ activate: 'when_none' });
    await seed(w);
    await w.installer.install(
      await makePackage({
        workflows: [
          { id: 'review', version: '1.0.0' },
          { id: 'extra', version: '1.0.0' },
        ],
      }),
      { approve: yes },
    );
    expect(await versionsOf(w, 'review')).toEqual(['0.9.0:active', '1.0.0:inactive']);
    expect(await versionsOf(w, 'extra')).toEqual(['1.0.0:active']);
  });

  it('`always` activates the highest version the package brought', async () => {
    const w = await world({ activate: 'always' });
    await seed(w);
    await w.installer.install(
      await makePackage({
        version: '2.0.0',
        workflows: [
          { id: 'review', version: '1.0.0' },
          { id: 'review', version: '1.5.0' },
        ],
      }),
      { approve: yes },
    );
    expect(await versionsOf(w)).toEqual(['0.9.0:inactive', '1.0.0:inactive', '1.5.0:active']);
  });

  it('`never` only saves', async () => {
    const w = await world({ activate: 'never' });
    const result = await w.installer.install(await makePackage(), { approve: yes });
    expect(await versionsOf(w)).toEqual(['1.0.0:inactive']);
    expect(result.workflows).toEqual([{ id: 'review', version: '1.0.0', active: false }]);
  });
});

describe('a failure while saving', () => {
  it('removes what it created and puts the active version back', async () => {
    const w = await world({ activate: 'always' });
    await w.library.install(JSON.parse(workflowYaml('review', '0.9.0')), { source: 'user' });
    let calls = 0;
    const failing = {
      install: (...args: Parameters<WorkflowLibrary['install']>) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('disk full'));
        return w.library.install(...args);
      },
      get: w.library.get.bind(w.library),
      active: w.library.active.bind(w.library),
      list: w.library.list.bind(w.library),
      activate: w.library.activate.bind(w.library),
      remove: w.library.remove.bind(w.library),
    };
    const broken = await world(
      { activate: 'always' },
      { library: failing as unknown as WorkflowLibrary },
    );
    // `broken` has its own store; build the case on the first world's store instead.
    void broken;
    const installer = new WorkflowPackageInstaller({
      library: failing,
      registry: w.registry,
      settings: () => w.settings,
      stagingDir: w.staging,
      events: w.store.events,
      logger: { error: (_fields, message) => w.errors.push(message) },
      clock: new FakeClock(),
      env: { PATH: process.env.PATH },
      cwd: await tempFolder(),
    });
    const folder = await makePackage({
      workflows: [
        { id: 'review', version: '1.0.0' },
        { id: 'extra', version: '1.0.0' },
      ],
    });
    await expect(installer.install(folder, { approve: yes })).rejects.toThrow(/disk full/);
    expect(await versionsOf(w, 'review')).toEqual(['0.9.0:active']);
    expect(await w.library.list({ workflowId: 'extra' })).toEqual([]);
    expect(await w.registry.list()).toEqual([]);
    expect(await eventsOf(w.store, 'workflow.package.installed')).toEqual([]);
  });
});

describe('removing a package', () => {
  it('removes the versions and the entry, and writes the event', async () => {
    const w = await world({ activate: 'never' });
    await w.installer.install(await makePackage(), { approve: yes });
    await w.installer.remove('review-kit');
    expect(await w.library.list()).toEqual([]);
    expect(await w.installer.list()).toEqual([]);
    expect(await eventsOf(w.store, 'workflow.package.removed')).toEqual([
      { packageId: 'review-kit', version: '1.0.0', workflows: ['review@1.0.0'] },
    ]);
  });

  it('refuses while a version of it is the active one, and removes nothing', async () => {
    const w = await world({ activate: 'always' });
    await w.installer.install(await makePackage(), { approve: yes });
    await expect(w.installer.remove('review-kit')).rejects.toThrow(Conflict);
    expect(await versionsOf(w)).toEqual(['1.0.0:active']);
    expect(await w.registry.get('review-kit')).toBeDefined();
    // Another version of the workflow becomes the active one, and then it goes.
    await w.library.install(JSON.parse(workflowYaml('review', '2.0.0')), {
      source: 'user',
      activate: true,
    });
    await w.installer.remove('review-kit');
    expect(await versionsOf(w)).toEqual(['2.0.0:active']);
  });

  it('says so when the package is not installed', async () => {
    const w = await world();
    await expect(w.installer.remove('nothing')).rejects.toThrow(NotFound);
  });

  it('keeps what it could not remove in the registry when a live run holds a version', async () => {
    const w = await world({ activate: 'never' });
    await w.installer.install(
      await makePackage({
        version: '2.0.0',
        workflows: [
          { id: 'review', version: '1.0.0' },
          { id: 'review', version: '1.1.0' },
        ],
      }),
      { approve: yes },
    );
    // A live run of the workflow: every version of it is held (the default of the library).
    await w.store.scenarios.create({
      id: 's1',
      kind: 'project',
      flowId: 'review',
      name: 's1',
      folder: '/work/s1',
      baseBranch: 'main',
    });
    await w.store.plays.create({
      id: 'p1',
      scenarioId: 's1',
      need: 'need',
      state: 'PLANNING',
      flowId: 'review',
      flowVersion: 1,
    });
    await expect(w.installer.remove('review-kit')).rejects.toThrow(Conflict);
    expect(await eventsOf(w.store, 'workflow.package.removed')).toEqual([]);
    expect((await w.registry.get('review-kit'))?.version).toBe('2.0.0');
  });
});

describe('housekeeping', () => {
  it('leaves nothing in the staging folder, after an install and after a refusal', async () => {
    const w = await world({ unsigned: 'reject' });
    await expect(w.installer.install(await makePackage(), { approve: yes })).rejects.toThrow();
    const accepting = await world();
    await accepting.installer.install(await makePackage(), { approve: yes });
    for (const place of [w, accepting]) {
      expect(await readdir(place.staging).catch(() => [])).toEqual([]);
    }
  });

  it('runs installs one after the other', async () => {
    const w = await world();
    const a = await makePackage({ id: 'a-kit', workflows: [{ id: 'alpha', version: '1.0.0' }] });
    const b = await makePackage({ id: 'b-kit', workflows: [{ id: 'beta', version: '1.0.0' }] });
    await Promise.all([
      w.installer.install(a, { approve: yes }),
      w.installer.install(b, { approve: yes }),
    ]);
    expect((await w.installer.list()).map((entry) => entry.id)).toEqual(['a-kit', 'b-kit']);
  });
});
