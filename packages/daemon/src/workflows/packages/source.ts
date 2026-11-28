// SPDX-License-Identifier: MPL-2.0
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { DEFAULT_YAML_LIMITS, parseWorkflowYaml } from '@otheater/workflows';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_MANIFEST_MAX_BYTES,
  PACKAGE_SIGNATURE_SUFFIX,
  parsePackageManifest,
  sha256Hex,
  sha256Of,
} from './manifest.js';

/**
 * Reading a workflow package from a folder or a file on disk (N298; plan of Phase 11b, P9). Nothing
 * here runs or interprets what it reads beyond YAML as data; every file is a regular file of the
 * package (no symbolic link, nothing outside the folder) and is bound by a size.
 */

/** A package as read from disk, before its workflows are validated. */
export interface LoadedPackage {
  readonly id: string;
  readonly version: string;
  readonly description: string | null;
  readonly kind: 'folder' | 'file';
  /** The bytes the author signed: `package.yaml`, or the file of a single workflow. */
  readonly signedBytes: Buffer;
  /** The text of the signature file next to it, or `null` when the package has none. */
  readonly signatureText: string | null;
  /** `sha256:<hex>` of `signedBytes`: the hash recorded for the package. */
  readonly hash: string;
  readonly workflows: readonly LoadedWorkflowFile[];
}

export interface LoadedWorkflowFile {
  /** The path inside the package (`workflows/review.yaml`), or the file name of a single file. */
  readonly path: string;
  readonly text: string;
}

const MAX_SIGNATURE_FILE_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

async function readRegularFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new InvalidInput(`${label} does not exist`, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new InvalidInput(`${label} is not a regular file (a link or a folder is not accepted)`);
  }
  if (info.size > maxBytes) {
    throw new InvalidInput(
      `${label} has ${String(info.size)} bytes; the limit is ${String(maxBytes)}`,
    );
  }
  return readFile(path);
}

function decode(bytes: Buffer, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new InvalidInput(`${label} is not UTF-8 text`, { cause: error });
  }
}

async function readSignature(path: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new InvalidInput(`${basename(path)} is not a regular file`);
  }
  return decode(
    await readRegularFile(path, basename(path), MAX_SIGNATURE_FILE_BYTES),
    basename(path),
  );
}

/**
 * Reads the package at `path`: a folder with `package.yaml`, that file itself, or a single workflow
 * file. `maxWorkflows` is `workflows.packages.max_workflows`. Throws `InvalidInput` for a missing
 * file, a link, a path that leaves the folder, a file over the size limit, a manifest that is not
 * valid, and a file whose bytes do not match the SHA-256 of the manifest.
 */
export async function readPackage(path: string, maxWorkflows: number): Promise<LoadedPackage> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new InvalidInput(`${path} does not exist`, { cause: error });
  }
  const real = info.isSymbolicLink() ? await realpath(path) : path;
  const target = await lstat(real);
  if (target.isDirectory()) return readFolder(real, maxWorkflows);
  if (!target.isFile()) throw new InvalidInput(`${path} is neither a folder nor a file`);
  if (basename(real) === PACKAGE_MANIFEST_FILE) return readFolder(dirname(real), maxWorkflows);
  return readSingleFile(real);
}

async function readFolder(root: string, maxWorkflows: number): Promise<LoadedPackage> {
  const manifestPath = join(root, PACKAGE_MANIFEST_FILE);
  const manifestBytes = await readRegularFile(
    manifestPath,
    PACKAGE_MANIFEST_FILE,
    PACKAGE_MANIFEST_MAX_BYTES,
  );
  const manifest = parsePackageManifest(decode(manifestBytes, PACKAGE_MANIFEST_FILE), maxWorkflows);
  const realRoot = await realpath(root);
  const workflows: LoadedWorkflowFile[] = [];
  for (const entry of manifest.workflows) {
    const file = join(root, ...entry.path.split('/'));
    let realFile: string;
    try {
      realFile = await realpath(file);
    } catch (error) {
      throw new InvalidInput(`${entry.path} does not exist`, { cause: error });
    }
    if (!realFile.startsWith(realRoot + sep)) {
      throw new InvalidInput(`${entry.path} is outside the package folder`);
    }
    const bytes = await readRegularFile(file, entry.path, DEFAULT_YAML_LIMITS.maxBytes);
    if (sha256Hex(bytes) !== entry.sha256) {
      throw new InvalidInput(
        `${entry.path} does not match the sha256 in ${PACKAGE_MANIFEST_FILE}: the file changed after the manifest was written`,
      );
    }
    workflows.push({ path: entry.path, text: decode(bytes, entry.path) });
  }
  return {
    id: manifest.id,
    version: manifest.version,
    description: manifest.description ?? null,
    kind: 'folder',
    signedBytes: manifestBytes,
    signatureText: await readSignature(manifestPath + PACKAGE_SIGNATURE_SUFFIX),
    hash: sha256Of(manifestBytes),
    workflows,
  };
}

async function readSingleFile(file: string): Promise<LoadedPackage> {
  const name = basename(file);
  const bytes = await readRegularFile(file, name, DEFAULT_YAML_LIMITS.maxBytes);
  const text = decode(bytes, name);
  const parsed = parseWorkflowYaml(text);
  if (!parsed.ok) {
    throw new InvalidInput(
      `${name} is not valid YAML: ${parsed.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const value = parsed.value as { id?: unknown; version?: unknown; description?: unknown } | null;
  if (typeof value?.id !== 'string' || typeof value.version !== 'string') {
    throw new InvalidInput(`${name} is not a workflow definition: it has no id and version`);
  }
  return {
    id: value.id,
    version: value.version,
    description: typeof value.description === 'string' ? value.description : null,
    kind: 'file',
    signedBytes: bytes,
    signatureText: await readSignature(file + PACKAGE_SIGNATURE_SUFFIX),
    hash: sha256Of(bytes),
    workflows: [{ path: name, text }],
  };
}
