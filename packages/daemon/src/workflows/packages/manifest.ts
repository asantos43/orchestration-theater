// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { InvalidInput, WORKFLOW_ID_PATTERN, WORKFLOW_VERSION_PATTERN } from '@otheater/core';
import { parseWorkflowYaml } from '@otheater/workflows';
import { z } from 'zod';

/**
 * The manifest of a workflow package (N298; plan of Phase 11b, P9). Every name here is [proposta]
 * (docs/24 fixes that a package is a folder or a file, not its layout):
 *
 * - a package folder holds `package.yaml` and the workflow files it lists; the signature is
 *   `package.yaml.sshsig`, made over the exact bytes of `package.yaml`;
 * - the manifest lists each workflow file with the SHA-256 of its bytes, so the one signature over
 *   the manifest covers every file: a file changed after signing no longer matches its hash and the
 *   package is refused;
 * - a package that is a single workflow file has no manifest: its signature is `<file>.sshsig`,
 *   over the bytes of the file, and its package id is the id of the workflow.
 */

export const PACKAGE_MANIFEST_FILE = 'package.yaml';
export const PACKAGE_SIGNATURE_SUFFIX = '.sshsig';
export const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A path inside the package: written with `/`, relative, no `.` or `..`, and the name of a YAML file.
 * It is checked as text, before any file is touched; reading it also checks what is on disk.
 */
export function isPackageRelativePath(path: string): boolean {
  if (path.length > 200 || !/\.ya?ml$/iu.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== '..');
}

const WorkflowEntrySchema = z.strictObject({
  path: z.string().refine(isPackageRelativePath, 'a relative path with /, ending in .yaml or .yml'),
  sha256: z.string().regex(SHA256_HEX, 'the SHA-256 of the file, in lowercase hexadecimal'),
});

export const PackageManifestSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID_PATTERN, 'an id is lowercase, with _ or -'),
  version: z.string().regex(WORKFLOW_VERSION_PATTERN, 'a version is semver (1.0.0)'),
  description: z.string().max(2000).optional(),
  workflows: z.array(WorkflowEntrySchema).min(1),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

/** `sha256:<hex>` of some bytes: the hash recorded for a package and for its manifest. */
export function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The bare hexadecimal SHA-256 of some bytes, as a manifest writes it. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const where = issue.path.map(String).join('.');
  return `${where === '' ? '(root)' : where}: ${issue.message}`;
}

/** Reads the text of `package.yaml`. Throws `InvalidInput` saying what is wrong and where. */
export function parsePackageManifest(text: string, maxWorkflows: number): PackageManifest {
  const parsed = parseWorkflowYaml(text, { maxBytes: PACKAGE_MANIFEST_MAX_BYTES, maxAliases: 10 });
  if (!parsed.ok) {
    throw new InvalidInput(
      `${PACKAGE_MANIFEST_FILE} is not valid YAML: ${parsed.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const result = PackageManifestSchema.safeParse(parsed.value);
  if (!result.success) {
    const shown = result.error.issues.slice(0, 5).map(describeIssue).join('; ');
    throw new InvalidInput(`${PACKAGE_MANIFEST_FILE} is not valid: ${shown}`);
  }
  const manifest = result.data;
  if (manifest.workflows.length > maxWorkflows) {
    throw new InvalidInput(
      `${PACKAGE_MANIFEST_FILE} lists ${String(manifest.workflows.length)} workflows; workflows.packages.max_workflows is ${String(maxWorkflows)}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of manifest.workflows) {
    if (seen.has(entry.path)) {
      throw new InvalidInput(`${PACKAGE_MANIFEST_FILE} lists ${entry.path} twice`);
    }
    seen.add(entry.path);
  }
  return manifest;
}

/**
 * The text of a `package.yaml` for some files: what an author signs. Strings are written as JSON,
 * which is also valid YAML. The order of `workflows` is the one given.
 */
export function buildPackageManifest(input: {
  readonly id: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly workflows: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}): string {
  const lines = [`id: ${JSON.stringify(input.id)}`, `version: ${JSON.stringify(input.version)}`];
  if (input.description !== undefined)
    lines.push(`description: ${JSON.stringify(input.description)}`);
  lines.push('workflows:');
  for (const file of input.workflows) {
    lines.push(
      `  - path: ${JSON.stringify(file.path)}`,
      `    sha256: ${JSON.stringify(sha256Hex(file.bytes))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
