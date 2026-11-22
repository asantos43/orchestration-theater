// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve, win32 } from 'node:path';
import { AdapterUnavailable, InvalidInput } from '@otheater/core';
import semver from 'semver';
import type { Env } from '../paths.js';
import type { PluginOrigin } from './registry.js';

/**
 * Where a plugin is fetched from, and how (N236, Phase 9, P4). Nothing here runs code of the
 * plugin: npm runs with `--ignore-scripts` and git with no hooks, so a `postinstall` script or a
 * hook in the repository is data. What runs are `npm` and `git` themselves, started with no shell,
 * with an argument list built from values checked here, and with a small environment (see
 * {@link childEnv}).
 */

/** An origin as the Producer wrote it, checked but not yet fetched. */
export type OriginSpec =
  | { readonly source: 'path'; readonly path: string }
  | { readonly source: 'npm'; readonly name: string; readonly version: string }
  | { readonly source: 'git'; readonly url: string; readonly ref: string | undefined };

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;
/** `user@host:path` (scp style, ssh). */
const GIT_SCP_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[A-Za-z0-9._~/-]+$/;

/**
 * Reads `<origin>`: `npm:<package>@<exact version>`, `git:<url>#<ref>` (the `#<ref>` is optional,
 * [proposta]: without it the default branch), `path:<folder>` or a bare folder. A relative folder
 * is made absolute against `cwd`. Throws `InvalidInput` saying what is wrong.
 */
export function parseOrigin(text: string, cwd: string): OriginSpec {
  if (text.startsWith('npm:')) return parseNpmOrigin(text.slice(4));
  if (text.startsWith('git:')) return parseGitOrigin(text.slice(4));
  const path = text.startsWith('path:') ? text.slice(5) : text;
  if (path === '' || path.includes('\0')) {
    throw new InvalidInput(
      'The origin is empty: use a folder, npm:<package>@<version> or git:<url>#<ref>',
    );
  }
  return { source: 'path', path: resolve(cwd, path) };
}

function parseNpmOrigin(spec: string): OriginSpec {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : '';
  if (!NPM_NAME.test(name) || name.length > 214) {
    throw new InvalidInput(
      `"${name}" is not an npm package name (lowercase, as in npm:@scope/name@1.2.3)`,
    );
  }
  if (version === '' || semver.valid(version) !== version) {
    throw new InvalidInput(
      `npm:${spec}: write the exact version (npm:${name}@1.2.3): a range or a tag is not accepted`,
    );
  }
  return { source: 'npm', name, version };
}

function parseGitOrigin(spec: string): OriginSpec {
  const hash = spec.lastIndexOf('#');
  const url = hash >= 0 ? spec.slice(0, hash) : spec;
  const ref = hash >= 0 ? spec.slice(hash + 1) : undefined;
  assertGitUrl(url);
  if (ref !== undefined && (!GIT_REF.test(ref) || ref.includes('..') || ref.endsWith('.lock'))) {
    throw new InvalidInput(`"${ref}" is not a branch, tag or commit of a repository`);
  }
  return { source: 'git', url, ref };
}

/**
 * The URLs a plugin may be cloned from [proposta]: `https://`, `ssh://`, `user@host:path` and
 * `file://`. Not `http://` and `git://` (no encryption, no authentication), not `ext::` or any
 * helper (it runs a command), not a URL that starts with `-` (it would be an option of git), and
 * not a password in the URL (it would be written to `plugins.json` and to the log).
 */
export function assertGitUrl(url: string): void {
  // eslint-disable-next-line no-control-regex
  if (url === '' || url.startsWith('-') || /[\s\u0000-\u001f]/.test(url)) {
    throw new InvalidInput(`"${url}" is not a git URL`);
  }
  if (GIT_SCP_URL.test(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidInput(
      `"${url}" is not a git URL (use https://, ssh://, user@host:path or file://)`,
    );
  }
  if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol)) {
    throw new InvalidInput(
      `git URLs of "${parsed.protocol.slice(0, -1)}" are not accepted: use https://, ssh://, user@host:path or file://`,
    );
  }
  if (parsed.password !== '') {
    throw new InvalidInput(
      'Do not put a password in the git URL: it would be kept in plugins.json',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Running npm and git

export interface CommandRun {
  readonly file: string;
  readonly args: readonly string[];
  /** What the messages call the command when `file` is not it (npm on Windows is `node npm-cli.js`). */
  readonly label?: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Runs a program with no shell. Rejects when it exits with an error, times out or is not found. */
export type CommandRunner = (run: CommandRun) => Promise<{ readonly stdout: string }>;

/** The real runner: `execFile`, which starts the program directly, with a time limit. */
export const execRunner: CommandRunner = (run) =>
  new Promise((resolve, reject) => {
    execFile(
      run.file,
      [...run.args],
      {
        cwd: run.cwd,
        env: { ...run.env },
        timeout: run.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout });
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new AdapterUnavailable(`"${run.label ?? run.file}" was not found in PATH`, {
              cause: error,
            }),
          );
          return;
        }
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(
          new InvalidInput(
            `${run.label ?? `${run.file} ${run.args.slice(0, 2).join(' ')}`} ${timedOut ? 'did not finish in time' : 'failed'}${tail === '' ? '' : `:\n${tail}`}`,
            { cause: error },
          ),
        );
      },
    );
  });

/** How to start npm: the program and the arguments that come before the ones of the command. */
export interface NpmCommand {
  readonly file: string;
  readonly prefix: readonly string[];
}

/** What {@link resolveNpmCommand} reads from the machine; each part can be given by a test. */
export interface NpmLookup {
  /** `plugins.install.npm`: `auto` (default), or the path of `npm-cli.js` or of an npm program. */
  readonly configured?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** The `node` that runs the daemon. */
  readonly execPath?: string | undefined;
  readonly exists?: ((path: string) => boolean) | undefined;
}

/**
 * Finds how to run npm with no shell. [proposta] On Windows npm is `npm.cmd`, and Node refuses to
 * start a `.cmd` with no shell (the fix of CVE-2024-27980), so the daemon runs its own `node` on the
 * `npm-cli.js` that comes next to it (`<node folder>\node_modules\npm\bin\npm-cli.js`, the layout
 * of the installer and of the zip of Node [S]). Elsewhere `npm` is a program and PATH finds it.
 * `configured` other than `auto` wins: a `.js`, `.cjs` or `.mjs` file runs on `node`, anything else
 * is started as it is. Throws `AdapterUnavailable` saying where it looked.
 */
export function resolveNpmCommand(lookup: NpmLookup = {}): NpmCommand {
  const platform = lookup.platform ?? process.platform;
  const execPath = lookup.execPath ?? process.execPath;
  const exists = lookup.exists ?? existsSync;
  const configured = lookup.configured?.trim() ?? 'auto';
  if (configured !== 'auto') {
    const path = platform === 'win32' ? win32 : posix;
    if (path.basename(configured) !== configured && !exists(configured)) {
      throw new AdapterUnavailable(`plugins.install.npm: "${configured}" does not exist`);
    }
    return /\.[cm]?js$/i.test(configured)
      ? { file: execPath, prefix: [configured] }
      : { file: configured, prefix: [] };
  }
  if (platform !== 'win32') return { file: 'npm', prefix: [] };
  const cli = win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(cli)) {
    throw new AdapterUnavailable(
      `npm was not found next to node (${cli}): set plugins.install.npm to the path of npm-cli.js`,
    );
  }
  return { file: execPath, prefix: [cli] };
}

/** The variables a child may see: where to find programs and its own home, proxies and npm's settings. */
const CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/**
 * The environment of `npm` and `git`: a short list (above) and, for npm only, its own
 * `npm_config_*` settings (registry, cache...). Nothing else of the daemon's environment goes in,
 * so no key or token in it reaches a package manager, and so no script of it, even though none runs.
 */
export function childEnv(
  base: Env,
  program: 'npm' | 'git',
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const npmSetting = program === 'npm' && /^npm_config_/i.test(key);
    if (CHILD_ENV_KEYS.has(key) || npmSetting) env[key] = value;
  }
  return { ...env, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Fetching

/** A fetched plugin, in a folder of the staging area that the installer checks and moves. */
export interface Fetched {
  /** The folder the installer moves to `<data>/plugins/<id>/<version>/`. */
  readonly root: string;
  /** The folder of the plugin inside `root` (`.` for git, `node_modules/<name>` for npm). */
  readonly relativeDir: string;
  readonly origin: PluginOrigin;
  /** The version the package manager gave (npm), to compare with the manifest. */
  readonly packageVersion?: string | undefined;
}

export interface FetchContext {
  readonly runner: CommandRunner;
  readonly env: Env;
  readonly timeoutMs: number;
  /** An empty folder the fetch may use as its workspace; the caller deletes it afterwards. */
  readonly stage: string;
  /** How to start npm (default: {@link resolveNpmCommand} with its defaults). */
  readonly npm?: NpmCommand | undefined;
}

/**
 * Installs `<name>@<version>` with npm into `stage/npm`, with `--ignore-scripts`: no lifecycle
 * script of the package or of any dependency runs. The package hash kept in the registry is the
 * `integrity` npm wrote in the lock file.
 */
export async function fetchNpm(
  spec: { readonly name: string; readonly version: string },
  context: FetchContext,
): Promise<Fetched> {
  const root = join(context.stage, 'npm');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'otheater-plugin-stage', version: '0.0.0', private: true }),
  );
  const npm = context.npm ?? resolveNpmCommand();
  await context.runner({
    file: npm.file,
    label: 'npm install',
    args: [
      ...npm.prefix,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--save-exact',
      '--loglevel=error',
      `${spec.name}@${spec.version}`,
    ],
    cwd: root,
    env: childEnv(context.env, 'npm'),
    timeoutMs: context.timeoutMs,
  });
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; integrity?: string } | undefined>;
  };
  const entry = lock.packages?.[`node_modules/${spec.name}`];
  if (entry?.version !== spec.version) {
    throw new InvalidInput(
      `npm installed ${spec.name} ${entry?.version ?? '?'}, not ${spec.version}`,
    );
  }
  if (entry.integrity === undefined || entry.integrity === '') {
    throw new InvalidInput(
      `npm gave no integrity hash for ${spec.name}@${spec.version}: not accepted`,
    );
  }
  return {
    root,
    relativeDir: join('node_modules', ...spec.name.split('/')),
    origin: { kind: 'npm', name: spec.name, version: spec.version, integrity: entry.integrity },
    packageVersion: spec.version,
  };
}

/**
 * Clones a repository with no hooks and pins it to a commit. [proposta] Every way a clone could
 * run something is shut: `core.hooksPath` points to an empty folder and `--template=` copies no
 * hook template (a hook runs on checkout), `protocol.ext.allow=never` (helpers that run a command),
 * `GIT_TERMINAL_PROMPT=0` (never wait for a password), no system or user configuration (filters,
 * credential helpers, aliases), and the `.git` folder is deleted at the end, so the folder is the
 * files of the commit and nothing that git would act on later.
 */
export async function fetchGit(
  spec: { readonly url: string; readonly ref: string | undefined },
  context: FetchContext,
): Promise<Fetched> {
  assertGitUrl(spec.url);
  const work = join(context.stage, 'work');
  const noHooks = join(context.stage, 'no-hooks');
  await mkdir(noHooks, { recursive: true });
  const config = [
    '-c',
    `core.hooksPath=${noHooks}`,
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'advice.detachedHead=false',
  ];
  const env = childEnv(context.env, 'git', {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file:https:ssh',
  });
  const git = async (cwd: string, args: readonly string[]): Promise<string> =>
    (
      await context.runner({
        file: 'git',
        args: [...config, ...args],
        cwd,
        env,
        timeoutMs: context.timeoutMs,
      })
    ).stdout.trim();

  await git(context.stage, [
    'clone',
    '--no-checkout',
    '--template=',
    '--quiet',
    '--',
    spec.url,
    work,
  ]);
  const candidates = spec.ref === undefined ? ['HEAD'] : [spec.ref, `origin/${spec.ref}`];
  let commit: string | undefined;
  for (const candidate of candidates) {
    try {
      commit = await git(work, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      if (/^[0-9a-f]{40,64}$/.test(commit)) break;
      commit = undefined;
    } catch {
      commit = undefined;
    }
  }
  if (commit === undefined) {
    throw new InvalidInput(`The repository has no "${spec.ref ?? 'HEAD'}" (branch, tag or commit)`);
  }
  await git(work, ['checkout', '--quiet', '--detach', commit, '--']);
  await rm(join(work, '.git'), { recursive: true, force: true });
  return {
    root: work,
    relativeDir: '.',
    origin: { kind: 'git', url: spec.url, ref: spec.ref ?? 'HEAD', commit },
  };
}

/** Checks a local folder: it exists and is a folder. Returns it as given (the caller made it absolute). */
export async function checkFolder(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new InvalidInput(`${path} does not exist`, { cause: error });
  }
  if (!info.isDirectory()) throw new InvalidInput(`${path} is not a folder`);
}
