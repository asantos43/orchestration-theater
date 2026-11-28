// SPDX-License-Identifier: MPL-2.0
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateTestKey,
  removeTempFolders,
  signSshsig,
  tempFolder,
  workflowYaml,
  writePackageFolder,
} from './packages.test-support.js';
import { sha256Of } from './manifest.js';
import { readPackage } from './source.js';

afterEach(removeTempFolders);

const REVIEW = workflowYaml('review', '1.0.0');

async function folderWith(
  files = [{ path: 'workflows/review.yaml', text: REVIEW }],
): Promise<string> {
  const root = await tempFolder();
  await writePackageFolder(root, { id: 'review-kit', version: '1.0.0', files });
  return root;
}

describe('readPackage: a folder', () => {
  it('reads the manifest, the workflows and the signature', async () => {
    const root = await tempFolder();
    const key = generateTestKey();
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      description: 'Review workflows',
      files: [{ path: 'workflows/review.yaml', text: REVIEW }],
      signWith: key,
    });
    const loaded = await readPackage(root, 10);
    expect(loaded).toMatchObject({
      id: 'review-kit',
      version: '1.0.0',
      description: 'Review workflows',
      kind: 'folder',
      workflows: [{ path: 'workflows/review.yaml', text: REVIEW }],
    });
    expect(loaded.signatureText).toContain('BEGIN SSH SIGNATURE');
    expect(loaded.hash).toBe(sha256Of(loaded.signedBytes));
  });

  it('has no signature when the file is not there, and accepts package.yaml as the path', async () => {
    const root = await folderWith();
    const loaded = await readPackage(join(root, 'package.yaml'), 10);
    expect(loaded.signatureText).toBeNull();
    expect(loaded.kind).toBe('folder');
  });

  it('refuses a file that changed after the manifest was written', async () => {
    const root = await folderWith();
    await writeFile(join(root, 'workflows/review.yaml'), `${REVIEW}# changed\n`);
    await expect(readPackage(root, 10)).rejects.toThrow(/does not match the sha256/);
  });

  it('refuses a folder without manifest, a missing workflow file and a folder of files', async () => {
    const empty = await tempFolder();
    await expect(readPackage(empty, 10)).rejects.toThrow(/package.yaml does not exist/);
    await expect(readPackage(join(empty, 'nothing'), 10)).rejects.toThrow(InvalidInput);
    const root = await folderWith();
    await writeFile(join(root, 'workflows/review.yaml'), '');
    await expect(readPackage(root, 10)).rejects.toThrow(InvalidInput);
  });

  it('refuses a workflow file that is a link to a file outside the package folder', async () => {
    const outside = await tempFolder();
    await writeFile(join(outside, 'secret.yaml'), REVIEW);
    const root = await tempFolder();
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      files: [{ path: 'linked/review.yaml', text: REVIEW }],
    });
    await rm(join(root, 'linked', 'review.yaml'));
    await symlink(join(outside, 'secret.yaml'), join(root, 'linked', 'review.yaml'));
    await expect(readPackage(root, 10)).rejects.toThrow(/outside the package folder/);
  });

  it('refuses a signature that is a link', async () => {
    const outside = await tempFolder();
    const target = join(outside, 'sig');
    await writeFile(target, signSshsig(Buffer.from('x'), generateTestKey()));
    const root = await folderWith();
    await symlink(target, join(root, 'package.yaml.sshsig'));
    await expect(readPackage(root, 10)).rejects.toThrow(/not a regular file/);
  });

  it('refuses text that is not UTF-8', async () => {
    const root = await tempFolder();
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      files: [{ path: 'a.yaml', text: REVIEW }],
    });
    await writeFile(join(root, 'a.yaml'), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(readPackage(root, 10)).rejects.toThrow(/does not match the sha256|UTF-8/);
  });

  it('keeps to the maximum number of workflows', async () => {
    const root = await folderWith([
      { path: 'a.yaml', text: workflowYaml('a', '1.0.0') },
      { path: 'b.yaml', text: workflowYaml('b', '1.0.0') },
    ]);
    await expect(readPackage(root, 1)).rejects.toThrow(/max_workflows/);
    expect((await readPackage(root, 2)).workflows).toHaveLength(2);
  });
});

describe('readPackage: a single workflow file', () => {
  it('is its own package, with the signature next to it', async () => {
    const root = await tempFolder();
    const file = join(root, 'review.yaml');
    await writeFile(file, REVIEW);
    await writeFile(`${file}.sshsig`, signSshsig(Buffer.from(REVIEW), generateTestKey()));
    const loaded = await readPackage(file, 10);
    expect(loaded).toMatchObject({
      id: 'review',
      version: '1.0.0',
      kind: 'file',
      workflows: [{ path: 'review.yaml', text: REVIEW }],
    });
    expect(loaded.signedBytes.toString()).toBe(REVIEW);
    expect(loaded.signatureText).toContain('BEGIN SSH SIGNATURE');
  });

  it('refuses a file that is not a workflow', async () => {
    const root = await tempFolder();
    const file = join(root, 'notes.yaml');
    await writeFile(file, 'hello: world\n');
    await expect(readPackage(file, 10)).rejects.toThrow(/no id and version/);
    await writeFile(file, 'a: [\n');
    await expect(readPackage(file, 10)).rejects.toThrow(/not valid YAML/);
  });
});
