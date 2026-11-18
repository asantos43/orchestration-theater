// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, join } from 'node:path';
import { InvalidInput } from '@otheater/core';

/**
 * The `ccusage` source of each client of the OTheater, and the variables that point it at the
 * directory of a profile. By default `ccusage` reads the logs of the user's own clients
 * (`~/.claude`, `~/.codex`, the data folder of OpenCode), which hold conversations of other work,
 * so the environment of every run is built here and never inherited: the variables below are
 * ALWAYS set, to the profile for the client asked and to an empty folder for the others.
 *
 * Facts about `ccusage` are [S] (README and `config-schema.json` of `ccusage@20.0.48`, read on
 * 2026-11-18) or [V] (run against `ccusage@20.0.48` on 2026-11-18, with fixtures only). That
 * v20 reads `CLAUDE_CONFIG_DIR` is [V] (its error names the variable); that it reads `CODEX_HOME`
 * and `OPENCODE_DATA_DIR` is [S]: empty folders there gave empty answers, which does not prove the
 * variable was read.
 */

/** The sub-command of `ccusage` that reads each client of the OTheater. */
export const CCUSAGE_SUBCOMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/** Variables of the parent environment the tool needs to start (`#!/usr/bin/env node`). */
const INHERITED_ENV = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TMPDIR', 'TEMP', 'TMP'];

/** The empty folders (inside the adapter's own home) that stand for the clients not asked. */
function emptyHomes(home: string): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: join(home, 'empty', 'claude'),
    CODEX_HOME: join(home, 'empty', 'codex'),
    OPENCODE_DATA_DIR: join(home, 'empty', 'opencode'),
  };
}

/** Where OpenCode keeps its data inside an isolated profile (`client-opencode`: `<dir>/data`). */
function opencodeHomes(profileDir: string): Record<string, string> {
  return {
    XDG_DATA_HOME: join(profileDir, 'data'),
    XDG_CONFIG_HOME: join(profileDir, 'config'),
    XDG_STATE_HOME: join(profileDir, 'state'),
    OPENCODE_DATA_DIR: join(profileDir, 'data', 'opencode'),
  };
}

export function assertAbsoluteDir(value: string, what: string): void {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new InvalidInput(`${what} must be an absolute path`);
  }
}

/**
 * The environment of a run that has no client to read (the `--version` check): the home of the
 * adapter and the empty folders, nothing of the user's.
 */
export function neutralEnv(
  home: string,
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ...emptyHomes(home),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

/**
 * The environment of a read of one profile: {@link neutralEnv} with the directory variables of the
 * client pointed at `profileDir`. `InvalidInput` for a client with no `ccusage` source or a
 * directory that is not absolute.
 */
export function profileEnv(
  clientId: string,
  profileDir: string,
  home: string,
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  assertAbsoluteDir(profileDir, 'the profile directory');
  const base = neutralEnv(home, parent);
  switch (clientId) {
    case 'claude-code':
      return { ...base, CLAUDE_CONFIG_DIR: profileDir };
    case 'codex':
      return { ...base, CODEX_HOME: profileDir };
    case 'opencode':
      return { ...base, ...opencodeHomes(profileDir) };
    default:
      throw new InvalidInput(`ccusage has no source for the client "${clientId}"`);
  }
}
