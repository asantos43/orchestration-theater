// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildPackageManifest,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_SIGNATURE_SUFFIX,
} from './manifest.js';
import { WORKFLOW_PACKAGE_SSHSIG_NAMESPACE } from './sshsig.js';

/**
 * Helpers of the tests of the workflow packages: temporary folders that are deleted at the end,
 * Ed25519 keys made in the test (nothing real, nothing read from the machine), an SSHSIG signer in
 * plain `node:crypto` (the daemon does not import `tools/`), workflow documents and package folders,
 * and a git repository made with the real `git`.
 */

const folders: string[] = [];

/** A new temporary folder; {@link removeTempFolders} deletes every one made so far. */
export async function tempFolder(prefix = 'otpkg-'): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

export async function removeTempFolders(): Promise<void> {
  const all = folders.splice(0);
  await Promise.all(all.map((folder) => rm(folder, { recursive: true, force: true })));
}

// ---------------------------------------------------------------------------------------------
// keys and SSHSIG

export interface TestKey {
  readonly privateKey: KeyObject;
  /** `ssh-ed25519 <base64>`, the line of `trusted_keys`. */
  readonly publicLine: string;
}

function sshString(value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function publicBlob(privateKey: KeyObject): Buffer {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.concat([sshString('ssh-ed25519'), sshString(der.subarray(der.length - 32))]);
}

/** A new Ed25519 key pair, made in the test. */
export function generateTestKey(): TestKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicLine: `ssh-ed25519 ${publicBlob(privateKey).toString('base64')}`,
  };
}

/** The armored SSHSIG of `message` (PROTOCOL.sshsig), made with `key` for `namespace`. */
export function signSshsig(
  message: Uint8Array,
  key: TestKey,
  namespace: string = WORKFLOW_PACKAGE_SSHSIG_NAMESPACE,
  hashAlgorithm: 'sha256' | 'sha512' = 'sha512',
): string {
  const digest = createHash(hashAlgorithm).update(message).digest();
  const signedData = Buffer.concat([
    Buffer.from('SSHSIG', 'latin1'),
    sshString(namespace),
    sshString(''),
    sshString(hashAlgorithm),
    sshString(digest),
  ]);
  const signature = sign(null, signedData, key.privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from('SSHSIG', 'latin1'),
    version,
    sshString(publicBlob(key.privateKey)),
    sshString(namespace),
    sshString(''),
    sshString(hashAlgorithm),
    sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(signature)])),
  ]);
  const lines = blob.toString('base64').match(/.{1,70}/gu) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`;
}

// ---------------------------------------------------------------------------------------------
// workflows and packages

export interface WorkflowOptions {
  readonly requiresTools?: readonly string[];
  readonly description?: string;
}

/** A sound workflow document as YAML text (JSON is YAML): read the issue, ask, comment, end. */
export function workflowYaml(id: string, version: string, options: WorkflowOptions = {}): string {
  return `${JSON.stringify(
    {
      id,
      version,
      engine: '>=1 <2',
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.requiresTools === undefined
        ? {}
        : { requires: { tools: [...options.requiresTools] } }),
      inputs: { strict: { type: 'boolean', default: false } },
      nodes: {
        read: { step: 'fetch_issue' },
        ask: { step: 'approval', params: { prompt: 'Comment?' } },
        answer: { step: 'comment', params: { target: 'issue', body: 'Thanks' } },
      },
      edges: [
        'read -> ask when output.state == "open"',
        'read -> done',
        'ask -> answer when output.approved',
        'ask -> cancelled',
        'answer -> done',
      ],
    },
    null,
    2,
  )}\n`;
}

export interface PackageFile {
  readonly path: string;
  readonly text: string;
}

export interface WritePackageOptions {
  readonly id: string;
  readonly version: string;
  readonly files: readonly PackageFile[];
  /** Signs the manifest with this key (`package.yaml.sshsig`). */
  readonly signWith?: TestKey;
  readonly namespace?: string;
  readonly description?: string;
}

async function write(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Writes a package folder (`package.yaml`, the files and, when asked, the signature) in `root`. */
export async function writePackageFolder(
  root: string,
  options: WritePackageOptions,
): Promise<void> {
  for (const file of options.files) await write(join(root, file.path), file.text);
  const manifest = buildPackageManifest({
    id: options.id,
    version: options.version,
    description: options.description,
    workflows: options.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
  });
  const manifestFile = join(root, PACKAGE_MANIFEST_FILE);
  await write(manifestFile, manifest);
  if (options.signWith !== undefined) {
    await write(
      manifestFile + PACKAGE_SIGNATURE_SUFFIX,
      signSshsig(Buffer.from(manifest), options.signWith, options.namespace),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// git

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'init.defaultBranch=main',
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
      (error, stdout) => {
        if (error === null) resolve(stdout.trim());
        else reject(error);
      },
    );
  });
}

/** Starts a repository in `root` (the real `git`). */
export async function gitInit(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ['init', '--quiet']);
}

/** Commits what is in `root`; returns the commit. */
export async function gitCommitAll(root: string, message: string): Promise<string> {
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

export async function gitTag(root: string, name: string): Promise<void> {
  await git(root, ['tag', name]);
}

/** `file://` URL of a folder on disk. */
export function fileUrl(folder: string): string {
  return `file://${folder}`;
}
