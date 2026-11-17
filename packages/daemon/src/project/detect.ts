// SPDX-License-Identifier: MPL-2.0
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONVENTIONS_VERSION,
  supportsInspect,
  type ChangelogFormat,
  type CiKind,
  type CommitStyle,
  type ProjectConventions,
  type Vcs,
} from '@otheater/core';

/** How many commit subjects the detection of the commit pattern reads. */
export const COMMIT_SAMPLE = 50;
/** Share of the sample that has to follow Conventional Commits for the pattern to be that one. */
export const CONVENTIONAL_SHARE = 0.6;
/** Most the detection reads of a file (a changelog can be huge; its head says its format). */
const READ_LIMIT = 256 * 1024;

/** Names (lowercase, any extension below) a changelog usually has at the root of a repository. */
const CHANGELOG_NAMES = ['changelog', 'changes', 'history', 'news', 'releases'];
const CHANGELOG_EXTENSIONS = ['', '.md', '.markdown', '.txt', '.rst'];

/** `type(scope)!: subject` of Conventional Commits 1.0. */
const CONVENTIONAL_SUBJECT =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\r\n]+\))?!?: \S/;

/** Subjects that say nothing about the pattern of the people: git's own and the bootstrap. */
const NEUTRAL_SUBJECT = /^(merge |revert "|initial commit|first commit|init$|fixup! |squash! )/i;

const OTHER_CI_FILES = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'Jenkinsfile',
  'azure-pipelines.yml',
  '.travis.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The first `READ_LIMIT` bytes of a regular file as text; `undefined` when it cannot be read. */
async function readHead(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Format of a changelog from its text. Keep a Changelog has `[Unreleased]` or the headings
 * `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security`; the files that
 * conventional-changelog, standard-version and release-please write have `Features` and
 * `Bug Fixes` and link every version to a comparison. Anything else is `other`.
 */
export function detectChangelogFormat(text: string): Exclude<ChangelogFormat, 'none'> {
  if (
    /keepachangelog\.com/i.test(text) ||
    /^#{2}\s*\[?unreleased\]?/im.test(text) ||
    /^#{3}\s*(added|changed|deprecated|removed|fixed|security)\s*$/im.test(text)
  ) {
    return 'keep-a-changelog';
  }
  if (
    /^#{3}\s*(features|bug fixes|performance improvements|⚠ BREAKING CHANGES)\s*$/im.test(text) ||
    /standard-version|conventional-changelog|release-please/i.test(text)
  ) {
    return 'conventional-changelog';
  }
  return 'other';
}

/** Share of the subjects that follow Conventional Commits, left the neutral ones out. */
export function commitStyleOf(subjects: readonly string[]): CommitStyle {
  const sample = subjects.filter((subject) => !NEUTRAL_SUBJECT.test(subject));
  if (sample.length === 0) return 'free';
  const conventional = sample.filter((subject) => CONVENTIONAL_SUBJECT.test(subject)).length;
  return conventional / sample.length >= CONVENTIONAL_SHARE ? 'conventional' : 'free';
}

/** The changelog file at the root of a repository, and what it holds. */
export async function findChangelog(
  repo: string,
): Promise<{ readonly file: string; readonly text: string } | undefined> {
  let names: string[];
  try {
    names = await readdir(repo);
  } catch {
    return undefined;
  }
  for (const wanted of CHANGELOG_NAMES) {
    for (const extension of CHANGELOG_EXTENSIONS) {
      const file = names.find((name) => name.toLowerCase() === `${wanted}${extension}`);
      if (file === undefined) continue;
      const text = await readHead(join(repo, file));
      if (text !== undefined) return { file, text };
    }
  }
  return undefined;
}

async function detectCi(repo: string): Promise<CiKind> {
  try {
    const workflows = await readdir(join(repo, '.github', 'workflows'));
    if (workflows.some((name) => /\.ya?ml$/i.test(name))) return 'github-actions';
  } catch {
    // No folder of workflows: look for another CI.
  }
  for (const file of OTHER_CI_FILES) {
    if (await exists(join(repo, file))) return 'other';
  }
  return 'none';
}

interface PackageManager {
  readonly name: string;
  readonly lockfiles: readonly string[];
}

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  { name: 'pnpm', lockfiles: ['pnpm-lock.yaml'] },
  { name: 'yarn', lockfiles: ['yarn.lock'] },
  { name: 'bun', lockfiles: ['bun.lock', 'bun.lockb'] },
];

/** The `npm` placeholder of a package that has no test yet. */
const NPM_NO_TEST = /no test specified/i;

/**
 * The commands to test and to install, when a file of the repository tells them: the scripts of
 * `package.json` (with the package manager of the lock file), `Cargo.toml`, `go.mod`, or a
 * `test` target of a `Makefile`. P3 reads them for `run_tests` and `install_deps`.
 */
export async function detectCommands(repo: string): Promise<{ test?: string; install?: string }> {
  const packageJson = await readHead(join(repo, 'package.json'));
  if (packageJson !== undefined) {
    let manager = 'npm';
    for (const candidate of PACKAGE_MANAGERS) {
      for (const lockfile of candidate.lockfiles) {
        if (manager === 'npm' && (await exists(join(repo, lockfile)))) manager = candidate.name;
      }
    }
    const commands: { test?: string; install?: string } = { install: `${manager} install` };
    try {
      const parsed = JSON.parse(packageJson) as { scripts?: { test?: unknown } };
      const test = parsed.scripts?.test;
      if (typeof test === 'string' && test.trim() !== '' && !NPM_NO_TEST.test(test)) {
        commands.test = `${manager} test`;
      }
    } catch {
      // A package.json that does not parse says nothing about its scripts.
    }
    return commands;
  }
  if (await exists(join(repo, 'Cargo.toml'))) return { test: 'cargo test', install: 'cargo fetch' };
  if (await exists(join(repo, 'go.mod')))
    return { test: 'go test ./...', install: 'go mod download' };
  const makefile = await readHead(join(repo, 'Makefile'));
  if (makefile !== undefined && /^test\s*:/m.test(makefile)) return { test: 'make test' };
  return {};
}

export interface DetectInput {
  readonly vcs: Vcs;
  /** Absolute path of the repository (its main checkout). */
  readonly repo: string;
  /** The base branch the Producer named, when one was. */
  readonly base?: string | undefined;
}

/**
 * Detects what a repository does by convention (architecture 5.20): the main branch, the format of
 * the changelog, the pattern of the commits, the CI and the commands of the tests and of the
 * install. Reads the files of the repository and its git history; changes nothing. What it finds is
 * `confirmed: false`, because the Producer has not seen it. A history it cannot read counts as no
 * history (`free`): the Producer corrects it.
 */
export async function detectConventions(input: DetectInput): Promise<ProjectConventions> {
  const { vcs, repo } = input;
  let mainBranch = input.base;
  let subjects: readonly string[] = [];
  if (supportsInspect(vcs)) {
    mainBranch ??= await vcs.defaultBranch(repo).catch(() => undefined);
    subjects = await vcs.recentSubjects(repo, mainBranch ?? 'HEAD', COMMIT_SAMPLE).catch(() => []);
  }
  const changelog = await findChangelog(repo);
  const commands = await detectCommands(repo);
  return {
    version: CONVENTIONS_VERSION,
    source: 'detected',
    confirmed: false,
    ...(mainBranch === undefined ? {} : { mainBranch }),
    changelog:
      changelog === undefined
        ? { format: 'none' }
        : { format: detectChangelogFormat(changelog.text), file: changelog.file },
    commit: { style: commitStyleOf(subjects), defaultType: 'feat' },
    ci: await detectCi(repo),
    commands,
  };
}
