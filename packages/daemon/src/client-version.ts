// SPDX-License-Identifier: MPL-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isClientVersion, UNKNOWN_CLIENT_VERSION, type ClientVersion } from '@otheater/core';
import type { ClientVersionSourceMode } from './config.js';
import type { FindExecutable } from './clients.js';

/** How many directories up from the executable the search for a `package.json` goes. */
const MAX_LEVELS = 12;

export interface InstalledVersionQuery {
  /** The executable the client starts (`clients.<id>.command.cmd`, or the default). */
  readonly command: string;
  /** Names the `package.json` may have: the package of the client or of its ACP adapter. */
  readonly packages: readonly string[];
  /** Looks the executable up in `PATH` without running it. */
  readonly find: FindExecutable;
}

/**
 * The version of the installed package that provides `command`, read from its `package.json`
 * (N63). It never runs anything: the executable is looked up in `PATH` (`find`), the link is
 * followed to the real file (`realpath`), and the directories above it are searched for a
 * `package.json` whose `name` is one of `packages`. A wrapper script, `npx`, a standalone binary
 * or a package that is not where it is expected gives `undefined`, never an error. [proposta]
 */
export function readInstalledVersion(query: InstalledVersionQuery): string | undefined {
  const found = query.find(query.command);
  if (found === undefined) return undefined;
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return undefined;
  }
  let dir = dirname(real);
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const version = versionOfPackageIn(dir, query.packages);
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** `version` of `<dir>/package.json` when its `name` is one of `names`; `undefined` otherwise. */
function versionOfPackageIn(dir: string, names: readonly string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { name, version } = parsed as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || !names.includes(name)) return undefined;
  return typeof version === 'string' && isClientVersion(version) ? version : undefined;
}

export interface ClientVersioningInput extends InstalledVersionQuery {
  readonly mode: ClientVersionSourceMode;
  /** `clients.<id>.client_version`; `unknown` when the user wrote none. */
  readonly written: string;
}

export interface ClientVersioning {
  /** What is known before the first session. */
  readonly initial: ClientVersion;
  /** Whether the `initialize` of a session may confirm or correct it. */
  readonly confirmByInitialize: boolean;
}

/**
 * Applies `version_source` (N63): where the version of a client comes from, before the first
 * session, and whether the `initialize` may correct it later. A written `client_version` wins in
 * every mode, and then nothing corrects it.
 *
 * - `auto`: the `package.json`, then the `initialize` confirms or corrects it;
 * - `package_json`: only the `package.json`;
 * - `initialize`: unknown until the first session says it;
 * - `config`: only `client_version`.
 */
export function resolveClientVersioning(input: ClientVersioningInput): ClientVersioning {
  if (input.written !== UNKNOWN_CLIENT_VERSION) {
    return { initial: { version: input.written, source: 'config' }, confirmByInitialize: false };
  }
  const reads = input.mode === 'auto' || input.mode === 'package_json';
  const read = reads ? readInstalledVersion(input) : undefined;
  return {
    initial:
      read === undefined
        ? { version: UNKNOWN_CLIENT_VERSION, source: 'unknown' }
        : { version: read, source: 'package_json' },
    confirmByInitialize: input.mode === 'auto' || input.mode === 'initialize',
  };
}
