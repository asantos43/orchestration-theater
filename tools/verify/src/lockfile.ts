// SPDX-License-Identifier: MPL-2.0

/** The platforms the single executable is built for (the ids of `tools/release`, N255). */
export const PLATFORM_IDS = ['linux-x64', 'win32-x64', 'darwin-arm64'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

interface PlatformSpec {
  readonly os: string;
  readonly cpu: string;
  /** The libc the executable is built against; only Linux has one. */
  readonly libc: string | undefined;
}

const SPECS: Readonly<Record<PlatformId, PlatformSpec>> = {
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'win32-x64': { os: 'win32', cpu: 'x64', libc: undefined },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', libc: undefined },
};

/** The platform of the machine that runs the check, when it is one of the supported ones. */
export function hostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformId | undefined {
  return PLATFORM_IDS.find((id) => SPECS[id].os === platform && SPECS[id].cpu === arch);
}

/** What `pnpm-lock.yaml` says a package needs from the machine (`os`, `cpu`, `libc`). */
export interface PlatformConstraint {
  readonly os: readonly string[] | undefined;
  readonly cpu: readonly string[] | undefined;
  readonly libc: readonly string[] | undefined;
}

export interface Lockfile {
  /** `name@version` -> the constraint, only for the packages that have one (the native binary packages). */
  readonly constrained: ReadonlyMap<string, PlatformConstraint>;
  /** `name@version` of a package -> its optional dependencies, name to version. */
  readonly optionalDependencies: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

function unquote(text: string): string {
  const quote = text[0];
  if ((quote === "'" || quote === '"') && text.endsWith(quote)) return text.slice(1, -1);
  return text;
}

/** `ink@8.0.0(react@19)` -> `ink@8.0.0`: the peer suffix of a snapshot is not part of the identity here. */
function withoutPeers(id: string): string {
  const open = id.indexOf('(');
  return open < 0 ? id : id.slice(0, open);
}

function parseList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
}

/**
 * Reads the two things the notices need from `pnpm-lock.yaml` (lockfile v9): the `os`/`cpu`/`libc` of
 * each package and the optional dependencies of each snapshot. The file is regular (two-space
 * indentation, one key per line, lists in flow style), so a line reader is enough and no YAML
 * dependency is added.
 */
export function parseLockfile(text: string): Lockfile {
  const constrained = new Map<string, PlatformConstraint>();
  const optionalDependencies = new Map<string, Map<string, string>>();
  let section: string | undefined;
  let id: string | undefined;
  let fields: { os?: string[]; cpu?: string[]; libc?: string[] } = {};
  let inOptional = false;
  const flush = (): void => {
    if (section === 'packages' && id !== undefined && (fields.os ?? fields.cpu) !== undefined) {
      constrained.set(id, { os: fields.os, cpu: fields.cpu, libc: fields.libc });
    }
    fields = {};
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      flush();
      id = undefined;
      inOptional = false;
      const header = /^([A-Za-z]+):\s*$/.exec(line);
      section = header?.[1];
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') continue;
    const entry = /^ {2}(\S.*):\s*(?:\{\})?$/.exec(line);
    if (entry?.[1] !== undefined && !line.startsWith('   ')) {
      flush();
      id = withoutPeers(unquote(entry[1]));
      inOptional = false;
      continue;
    }
    if (id === undefined) continue;
    const field = /^ {4}([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined) {
      const key = field[1];
      const value = field[2] ?? '';
      inOptional = section === 'snapshots' && key === 'optionalDependencies' && value === '';
      if (section === 'packages' && (key === 'os' || key === 'cpu' || key === 'libc')) {
        fields[key] = parseList(value);
      }
      continue;
    }
    if (inOptional) {
      const dep = /^ {6}(\S.*?):\s+(\S.*)$/.exec(line);
      if (dep?.[1] !== undefined && dep[2] !== undefined) {
        const map = optionalDependencies.get(id) ?? new Map<string, string>();
        map.set(unquote(dep[1]), withoutPeers(unquote(dep[2])));
        optionalDependencies.set(id, map);
      }
    }
  }
  flush();
  return { constrained, optionalDependencies };
}

/** npm's rule: a list that has a `!x` item excludes `x`; otherwise the value has to be in the list. */
function listAllows(list: readonly string[] | undefined, value: string | undefined): boolean {
  if (list === undefined || value === undefined) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((item) => !item.startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

/** Whether a package with `constraint` is installed on `platform` (for Linux, the glibc build). */
export function constraintMatches(constraint: PlatformConstraint, platform: PlatformId): boolean {
  const spec = SPECS[platform];
  return (
    listAllows(constraint.os, spec.os) &&
    listAllows(constraint.cpu, spec.cpu) &&
    listAllows(constraint.libc, spec.libc)
  );
}
