// SPDX-License-Identifier: MPL-2.0
// Phase 10, P13 (N254 revised): the pinned manifest of the managed ACP adapters. One lockfile per adapter
// holds only the subtree of the adapter (path, version, integrity, os/cpu), derived from the npm lockfiles
// of the spikes by this module. The daemon installs from these files and never resolves versions itself.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type CheckResult } from './common.js';

/** One package of the install tree. `path` is the key of the npm lockfile (`node_modules/a/node_modules/b`). */
export interface AdapterLockEntry {
  readonly path: string;
  /** The name on the registry (differs from the folder name for `npm:` aliases). */
  readonly name: string;
  readonly version: string;
  /** The tarball URL in the source lockfile (provenance only: the installer builds the URL from the registry). */
  readonly resolved?: string;
  /** The `sha512-...` SRI of the tarball. */
  readonly integrity: string;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly optional?: true;
}

export interface AdapterLock {
  readonly schema: 1;
  readonly id: string;
  readonly package: string;
  readonly version: string;
  /** The file of the adapter package to run with Node (the `bin` of its package.json). */
  readonly entry: string;
  readonly entries: readonly AdapterLockEntry[];
}

/** A package of an npm lockfile v3. */
export interface NpmLockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  optional?: boolean;
  dev?: boolean;
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export type NpmLockPackages = Readonly<Record<string, NpmLockPackage>>;

export interface AdapterLockSpec {
  readonly id: string;
  readonly packageName: string;
  /** The npm lockfile of the spike, relative to the repository root. */
  readonly source: string;
  /** Dependencies not followed: the adapter runs without them (reason in the docs of the step). */
  readonly skipPrefixes: readonly string[];
  /** The adapter is one bundled file: only its own package is installed. */
  readonly bundled: boolean;
}

export const ADAPTER_LOCK_SPECS: readonly AdapterLockSpec[] = [
  {
    id: 'claude-agent-acp',
    packageName: '@agentclientprotocol/claude-agent-acp',
    source: 'spikes/acp-claude/package-lock.json',
    // The native `claude` binaries: the daemon always sets CLAUDE_CODE_EXECUTABLE to the claude the user has.
    skipPrefixes: ['@anthropic-ai/claude-agent-sdk-'],
    bundled: false,
  },
  {
    id: 'codex-acp',
    packageName: '@agentclientprotocol/codex-acp',
    source: 'spikes/acp-codex/package-lock.json',
    // dist/index.js is one esbuild bundle (no import of the dependencies); `@openai/codex` is only
    // resolved when CODEX_PATH is empty, and the daemon always sets CODEX_PATH to the codex the user has.
    skipPrefixes: ['@openai/codex'],
    bundled: true,
  },
];

export const LOCKS_DIR = path.join('packages', 'daemon', 'src', 'adapters', 'locks');
export const LOCK_DATA_FILE = path.join('packages', 'daemon', 'src', 'adapters', 'lock-data.ts');

function dependencyNames(pkg: NpmLockPackage): string[] {
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional !== true) names.add(name);
  }
  return [...names];
}

/** Node resolution on lockfile keys: the nearest `node_modules/<name>` going up from `from`. */
export function resolveKey(
  packages: NpmLockPackages,
  from: string,
  name: string,
): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (base === '') return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

function realName(key: string, pkg: NpmLockPackage): string {
  return pkg.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

export function deriveAdapterLock(spec: AdapterLockSpec, packages: NpmLockPackages): AdapterLock {
  const rootKey = `node_modules/${spec.packageName}`;
  const root = packages[rootKey];
  if (root?.version === undefined) throw new Error(`${spec.source} has no ${rootKey}`);
  const bin = typeof root.bin === 'string' ? { [spec.id]: root.bin } : (root.bin ?? {});
  const entry = Object.values(bin)[0];
  if (entry === undefined) throw new Error(`${rootKey} declares no bin`);
  const seen = new Map<string, NpmLockPackage>();
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || seen.has(key)) continue;
    const pkg = packages[key];
    if (pkg === undefined) continue;
    seen.set(key, pkg);
    if (spec.bundled && key === rootKey) continue;
    for (const dep of dependencyNames(pkg)) {
      if (spec.skipPrefixes.some((prefix) => dep.startsWith(prefix))) continue;
      const resolved = resolveKey(packages, key, dep);
      if (resolved === undefined) {
        // npm leaves out an optional dependency of another platform; a hard one missing is an error.
        const optional =
          pkg.optionalDependencies?.[dep] !== undefined ||
          pkg.peerDependenciesMeta?.[dep]?.optional === true;
        if (!optional) throw new Error(`${key} depends on ${dep}, absent from ${spec.source}`);
        continue;
      }
      queue.push(resolved);
    }
  }
  const entries: AdapterLockEntry[] = [];
  for (const [key, pkg] of [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const { version, integrity, resolved } = pkg;
    if (version === undefined) throw new Error(`${key} has no version in ${spec.source}`);
    // Fail closed: a package that cannot be verified is not installed.
    if (integrity === undefined) throw new Error(`${key} has no integrity in ${spec.source}`);
    entries.push({
      path: key,
      name: realName(key, pkg),
      version,
      ...(resolved === undefined ? {} : { resolved }),
      integrity,
      ...(pkg.os === undefined ? {} : { os: pkg.os }),
      ...(pkg.cpu === undefined ? {} : { cpu: pkg.cpu }),
      ...(pkg.libc === undefined ? {} : { libc: pkg.libc }),
      ...(pkg.optional === true ? { optional: true as const } : {}),
    });
  }
  return {
    schema: 1,
    id: spec.id,
    package: spec.packageName,
    version: root.version,
    entry,
    entries,
  };
}

export function renderLockJson(lock: AdapterLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** The module the daemon imports: the same JSON, as TypeScript (the executable has no files beside it). */
export function renderLockData(locks: readonly AdapterLock[]): string {
  return `// SPDX-License-Identifier: MPL-2.0
// GENERATED by \`node tools/verify/dist/cli.js adapter-locks\` with the packages/daemon/src/adapters/locks/*.lock.json files, from the lockfiles of the spikes.
// Do not edit by hand: \`adapter-locks --check\` fails when this file is out of date.
export const ADAPTER_LOCK_DATA: readonly unknown[] = ${JSON.stringify(locks, null, 2)};
`;
}

export interface AdapterLockFiles {
  /** Relative path -> content. */
  readonly files: ReadonlyMap<string, string>;
  readonly summary: string[];
}

export function buildAdapterLockFiles(root: string): AdapterLockFiles {
  const locks: AdapterLock[] = [];
  const summary: string[] = [];
  for (const spec of ADAPTER_LOCK_SPECS) {
    const read = (file: string): NpmLockPackages => {
      const full = path.join(root, file);
      if (!existsSync(full)) throw new Error(`${file} not found`);
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as {
        lockfileVersion?: number;
        packages?: NpmLockPackages;
      };
      if (parsed.lockfileVersion !== 3 || parsed.packages === undefined)
        throw new Error(`${file} is not an npm lockfile v3`);
      return parsed.packages;
    };
    const lock = deriveAdapterLock(spec, read(spec.source));
    locks.push(lock);
    summary.push(
      `${lock.id}@${lock.version}: ${String(lock.entries.length)} package(s), all with integrity`,
    );
  }
  const files = new Map<string, string>();
  for (const lock of locks)
    files.set(path.join(LOCKS_DIR, `${lock.id}.lock.json`), renderLockJson(lock));
  files.set(LOCK_DATA_FILE, renderLockData(locks));
  return { files, summary };
}

export function writeAdapterLocks(root: string): readonly string[] {
  const { files, summary } = buildAdapterLockFiles(root);
  for (const [file, content] of files) writeFileSync(path.join(root, file), content);
  return summary;
}

/** `--check`: the files on disk are what the spikes' lockfiles derive. Absent spikes are not an error. */
export function checkAdapterLocks(root: string): CheckResult {
  const missing = ADAPTER_LOCK_SPECS.filter((spec) => !existsSync(path.join(root, spec.source)));
  if (missing.length > 0) {
    return {
      summary: [`skipped: ${missing.map((spec) => spec.source).join(', ')} not present`],
      findings: [],
    };
  }
  const { files, summary } = buildAdapterLockFiles(root);
  const findings: CheckResult['findings'] = [];
  for (const [file, content] of files) {
    const full = path.join(root, file);
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content) {
      findings.push({
        severity: 'error',
        subject: file,
        message: 'out of date: run `node tools/verify/dist/cli.js adapter-locks`',
      });
    }
  }
  return { summary, findings };
}
