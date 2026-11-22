// SPDX-License-Identifier: MPL-2.0
import {
  isRecord,
  requireArray,
  requireString,
  requireStringArray,
  UsageError,
  type ExecFn,
} from './common.js';

export type Level = 'B' | 'D';

/** One installed third-party package, as reported by `pnpm licenses list`. */
export interface InstalledPackage {
  name: string;
  version: string;
  /** License text as the package declares it. */
  license: string;
  /** Absolute path inside node_modules/.pnpm; kept in memory only, never written to a report. */
  path: string;
}

export type PnpmScope = 'prod' | 'dev';

/**
 * Parses the JSON of `pnpm licenses list --json`. The shape is `{ "<license>": [ { name, versions[], paths[], license } ] }`.
 * An empty tree makes pnpm print a plain sentence instead of JSON; that is the only non-JSON output accepted.
 */
export function parsePnpmLicenses(stdout: string): InstalledPackage[] {
  const text = stdout.trim();
  if (/^No licenses in packages found/i.test(text)) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError('unexpected output from "pnpm licenses list --json": not JSON');
  }
  if (!isRecord(json))
    throw new UsageError('unexpected output from "pnpm licenses list --json": not an object');
  const result: InstalledPackage[] = [];
  for (const [group, entries] of Object.entries(json)) {
    const where = `pnpm licenses list["${group}"]`;
    for (const [i, entry] of requireArray(entries, where).entries()) {
      const at = `${where}[${String(i)}]`;
      if (!isRecord(entry)) throw new UsageError(`${at}: expected an object`);
      const name = requireString(entry, 'name', at);
      const versions = requireStringArray(entry.versions, `${at}.versions`);
      const paths = requireStringArray(entry.paths, `${at}.paths`);
      if (versions.length !== paths.length) {
        throw new UsageError(`${at}: "versions" and "paths" have different lengths`);
      }
      const declared = entry.license;
      const license = typeof declared === 'string' ? declared : group;
      for (const [k, version] of versions.entries()) {
        const path = paths[k];
        if (path === undefined) throw new UsageError(`${at}: missing path for ${version}`);
        result.push({ name, version, license, path });
      }
    }
  }
  return result;
}

/**
 * How to start pnpm without a shell. When the process runs under pnpm, `npm_execpath` points at the exact pnpm that
 * started it (this also works on Windows, where `pnpm` is a .cmd file that execFile cannot start).
 */
export function resolvePnpmCommand(
  env: Readonly<Record<string, string | undefined>>,
  nodeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; prefix: string[] } {
  const execPath = env.npm_execpath;
  if (execPath !== undefined && /pnpm/i.test(execPath)) {
    if (/\.(c|m)?js$/i.test(execPath)) return { file: nodeExecutable, prefix: [execPath] };
    return { file: execPath, prefix: [] };
  }
  // Not started by pnpm (the release build runs `node tools/release/dist/cli.js`): on Windows the
  // `pnpm` on the PATH is a .cmd file, which only a shell starts. [N: only the Windows runner proves it]
  if (platform === 'win32') return { file: 'cmd.exe', prefix: ['/d', '/s', '/c', 'pnpm'] };
  return { file: 'pnpm', prefix: [] };
}

export async function listPnpmPackages(
  exec: ExecFn,
  root: string,
  scope: PnpmScope,
  command: { file: string; prefix: string[] },
): Promise<InstalledPackage[]> {
  const stdout = await exec(
    command.file,
    [...command.prefix, 'licenses', 'list', '--json', `--${scope}`],
    { cwd: root },
  );
  return parsePnpmLicenses(stdout);
}

export interface LeveledPackage extends InstalledPackage {
  level: Level;
}

/** Level B = production dependency of any workspace package; level D = development only. A package in both counts as B. */
export async function collectPackages(
  exec: ExecFn,
  root: string,
  command: { file: string; prefix: string[] },
  scopes: readonly PnpmScope[] = ['prod', 'dev'],
): Promise<LeveledPackage[]> {
  const byKey = new Map<string, LeveledPackage>();
  for (const scope of scopes) {
    const level: Level = scope === 'prod' ? 'B' : 'D';
    for (const pkg of await listPnpmPackages(exec, root, scope, command)) {
      const key = `${pkg.name}@${pkg.version}`;
      const existing = byKey.get(key);
      if (existing === undefined || (existing.level === 'D' && level === 'B')) {
        byKey.set(key, { ...pkg, level });
      }
    }
  }
  return [...byKey.values()];
}
