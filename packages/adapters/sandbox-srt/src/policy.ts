// SPDX-License-Identifier: MPL-2.0
import { createHmac } from 'node:crypto';
import { isSecretPath, type SandboxRequest } from '@otheater/core';

/** The four lists of the `filesystem` block of `sandbox-runtime`. */
export interface FilesystemRules {
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/**
 * What `sandbox-runtime` is told to deny on READ for a list of secret paths. An entry with a `/`
 * goes as it is (it is already absolute; `*` and `?` are the glob of the library). A bare name
 * (`.env`, `.env.*`) matches in any folder, but the library needs a literal folder to start from
 * (a pattern that starts with a wildcard is skipped, and a skipped deny hides nothing), so the name
 * is anchored under each of `roots` (`<root>/**\/.env`). [proposta] A `.env` outside the roots
 * stays readable: the worktree and the extra write folders are where a command works.
 */
export function readDenies(
  secretPaths: readonly string[],
  roots: readonly string[],
): readonly string[] {
  const denies: string[] = [];
  for (const entry of secretPaths) {
    if (entry.includes('/')) {
      denies.push(trimSlashes(entry));
      continue;
    }
    for (const root of roots) denies.push(`${trimSlashes(root)}/**/${entry}`);
  }
  return unique(denies);
}

/**
 * The filesystem rules of one request (architecture 5.8, layer 3): write only in the worktree,
 * the profile folders of the client, `extraWritePaths` and the temporary folder of the adapter;
 * read everything except the secret paths. A worktree or profile folder that lies INSIDE a secret
 * path (the data directory of the daemon holds both) is read again by `allowRead`, which beats
 * `denyRead` for the same path in the library.
 */
export function filesystemRules(request: SandboxRequest, tempDir: string): FilesystemRules {
  const writable = unique([
    request.worktree,
    ...request.profileDirs,
    ...request.extraWritePaths,
    tempDir,
  ]);
  const reopened = [request.worktree, ...request.profileDirs].filter((path) =>
    isSecretPath(path, request.secretPaths),
  );
  return {
    denyRead: readDenies(request.secretPaths, [request.worktree, ...request.extraWritePaths]),
    allowRead: unique(reopened),
    allowWrite: writable,
    denyWrite: [],
  };
}

/** Domains the command may reach: the ones of the role policy and the ones the daemon added. */
export function allowedDomains(request: SandboxRequest): readonly string[] {
  return unique([...request.policy.network.allow, ...request.domains]);
}

/** One argument quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `cmd args...` as one line for a POSIX shell, each word quoted. */
export function shellLine(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/**
 * The id under which the network list of a request is registered in the library (it travels in
 * the proxy user name). It must be unguessable (at least 128 bits), but the SAME request must give
 * the SAME id, so the wrapped command, and the key of a shared process, stay stable for a
 * worktree. An HMAC with a secret that lives as long as the adapter does both. [proposta]
 */
export function commandIdFor(secret: Buffer, request: SandboxRequest, tempDir: string): string {
  const material = JSON.stringify([
    request.worktree,
    [...request.profileDirs].sort(),
    [...request.extraWritePaths].sort(),
    [...request.secretPaths].sort(),
    [...allowedDomains(request)].sort(),
    request.policy.writeScope,
    tempDir,
  ]);
  return createHmac('sha256', secret).update(material).digest('base64url');
}
