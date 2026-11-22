// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which test files touch the operating system (owner, 2026-11-22, N162).
 *
 * The CI job `cross` (macOS and Windows) runs only these on a pull request (OT_CROSS_TESTS=os, see
 * tools/ci/test-affected.sh): the other tests are pure logic and give the same result on the three
 * systems. The linux job still runs everything, and a push to main runs everything on all systems,
 * which catches a test that this heuristic left out.
 *
 * A test file is "system" when, in this order:
 * 1. it carries a mark: `// ot-ci: cross` includes it, `// ot-ci: no-cross` excludes it. The marks
 *    beat the rules below. A file with both is included (never run less on a doubt);
 * 2. its path is an e2e, real or integration test or sits in a folder of {@link SYSTEM_PATHS};
 * 3. the test itself, the module it tests (same name without `.test`) or a module it imports with a
 *    relative path (one level only) shows one of the {@link SYSTEM_SIGNALS}.
 *
 * `node:fs` and `node:path` alone are not a signal: almost every test uses a temp folder. The sets
 * below are the knobs: add a signal or a folder here, with a test, when a test that touches the
 * system escapes the classifier.
 */

export interface Signal {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * `direct` signals are looked for in the test and in the module it tests (same name); `deep`
   * ones also in the modules the test imports (one level). A word that wiring modules mention
   * (a config, a composition root) is `direct` only: seen in an import it would pull in most tests.
   */
  readonly reach: 'direct' | 'deep';
}

export interface PathRule {
  readonly name: string;
  readonly pattern: RegExp;
}

/** What the text of a source shows when it touches the system. Matched on the text without line comments. */
export const SYSTEM_SIGNALS: readonly Signal[] = [
  // Processes, sockets, terminals, threads.
  { name: 'child_process', reach: 'deep', pattern: /['"](?:node:)?child_process['"]/ },
  {
    name: 'net',
    reach: 'deep',
    pattern: /['"](?:node:)?(?:net|tty|worker_threads|cluster|dgram)['"]/,
  },
  {
    name: 'spawn',
    reach: 'deep',
    pattern: /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/,
  },
  // Platform. A bare 'win32' or 'darwin' is not one: pure functions take it as a parameter.
  { name: 'platform', reach: 'direct', pattern: /\bprocess\.platform\b|\bos\.platform\s*\(/ },
  { name: 'path.sep', reach: 'direct', pattern: /\bpath\.(?:win32|posix|sep|delimiter)\b/ },
  { name: 'PATHEXT', reach: 'direct', pattern: /\bPATHEXT\b/ },
  // Signals.
  {
    name: 'signal',
    reach: 'direct',
    pattern: /\bSIG(?:TERM|INT|KILL|HUP|QUIT|STOP|CONT|PIPE|CHLD|USR[12])\b/,
  },
  { name: 'process.kill', reach: 'direct', pattern: /\bprocess\.kill\b/ },
  // File system features that differ between systems.
  { name: 'chmod/mode', reach: 'direct', pattern: /\bf?chmod(?:Sync)?\b|\bmode\s*&\s*0o/ },
  {
    name: 'symlink',
    reach: 'direct',
    pattern: /\b(?:symlink|readlink|realpath)(?:Sync)?\b|\blinkSync\b/,
  },
  {
    name: 'fs.watch',
    reach: 'direct',
    pattern: /\bwatchFile\b|\bfs\.watch\b|\bwatch\b[^;]*from\s*['"]node:fs(?:\/promises)?['"]/,
  },
  {
    name: 'fs error codes',
    reach: 'direct',
    pattern: /\b(?:EPERM|EBUSY|EACCES|ENOTEMPTY|EXDEV)\b/,
  },
  {
    name: 'named pipe',
    reach: 'deep',
    pattern: /named[- ]pipe|\\{2,4}[.?]\\{1,2}pipe|\.sock\b|socketPath|mkfifo|AF_UNIX/i,
  },
  // Native addon: one binary per platform.
  { name: 'native addon', reach: 'deep', pattern: /['"]better-sqlite3['"]/ },
  // The user's environment and the services of the system. Words that config and wiring mention.
  {
    name: 'homedir',
    reach: 'direct',
    pattern: /\bhomedir\s*\(|\b(?:USERPROFILE|APPDATA|LOCALAPPDATA)\b/,
  },
  {
    name: 'service',
    reach: 'direct',
    pattern: /systemd|systemctl|launchd|launchctl|schtasks|windows[- ]service|\bnssm\b/i,
  },
  { name: 'job launcher', reach: 'direct', pattern: /job-launcher|job object/i },
  // Packages whose job is the system (a test that imports one touches it).
  {
    name: 'system package',
    reach: 'direct',
    pattern:
      /@otheater\/(?:adapter-(?:platform-|vault-keyring|sandbox-|vcs-git|session-acp|browser-)|fake-agent)/,
  },
];

/**
 * Tests that always count as "system", by path. `*.e2e.test.ts[x]` is always one, and so are `*-e2e`
 * (18 tests spell it so), `*.real` (they run the real client) and `*.integration`. The folders are
 * those whose whole job is the system, so a test there counts even when its text shows no signal.
 */
export const SYSTEM_PATHS: readonly PathRule[] = [
  { name: 'e2e/real/integration', pattern: /[.-](?:e2e|real|integration)\.test\.tsx?$/ },
  {
    name: 'adapter folder',
    pattern:
      /^packages\/adapters\/(?:platform-[^/]+|vault-keyring|sandbox-srt|vcs-git|session-acp|browser-playwright)\//,
  },
  { name: 'fake-agent', pattern: /^packages\/fake-agent\// },
  { name: 'daemon service', pattern: /^packages\/daemon\/src\/(?:service|sea|updates|shell)\// },
  { name: 'release', pattern: /^tools\/release\// },
  { name: 'native', pattern: /^native\// },
];

export interface Verdict {
  readonly file: string;
  readonly system: boolean;
  /** Why: `mark`, `path: <name>` or `signal <name> in <file>`. */
  readonly reason: string;
}

const MARKS = /^\s*\/\/\s*ot-ci:\s*(no-cross|cross)\b/gm;

/** The text without the whole-line comments, which mention SIGTERM or win32 without using them. */
export function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The source files a spec like `./x.js` may name, relative to the folder `dir`. */
function candidates(dir: string, spec: string): string[] {
  const base = path.posix.join(dir, spec);
  const noExt = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  if (noExt !== base) return [`${noExt}.ts`, `${noExt}.tsx`];
  if (/\.[a-z]+$/i.test(base) && !/\.(?:ts|tsx)$/.test(base)) return [];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}

function readIfExists(root: string, rel: string): string | undefined {
  try {
    return readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/** The module a test file tests, by name: `a.test.ts` tests `a.ts`. */
function sameNameModule(file: string): string | undefined {
  const same = file.replace(/\.test\.(tsx?)$/, '.$1');
  return same === file ? undefined : same;
}

/** The modules the test imports with a relative path (one level), without the one of the same name. */
function importedModules(root: string, file: string, text: string): string[] {
  const dir = path.posix.dirname(file);
  const same = sameNameModule(file);
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT)) {
    const found1 = candidates(dir, match[1] ?? '').find(
      (candidate) =>
        candidate !== file && candidate !== same && readIfExists(root, candidate) !== undefined,
    );
    if (found1 !== undefined) found.add(found1);
  }
  return [...found];
}

/** The first signal in `text`; for an imported helper (`imported`) only the `deep` ones count. */
function signalIn(text: string, imported: boolean): Signal | undefined {
  const code = stripLineComments(text);
  return SYSTEM_SIGNALS.find(
    (signal) => (!imported || signal.reach === 'deep') && signal.pattern.test(code),
  );
}

/** Classifies one test file. `file` is relative to `root`, with forward slashes. Never throws for a missing file: it counts as "system". */
export function classifyTest(root: string, file: string): Verdict {
  const text = readIfExists(root, file);
  if (text === undefined) return { file, system: true, reason: 'unreadable' };

  const marks = Array.from(text.matchAll(MARKS), (match) => match[1]);
  if (marks.includes('cross')) return { file, system: true, reason: 'mark: cross' };
  if (marks.includes('no-cross')) return { file, system: false, reason: 'mark: no-cross' };

  const byPath = SYSTEM_PATHS.find((rule) => rule.pattern.test(file));
  if (byPath) return { file, system: true, reason: `path: ${byPath.name}` };

  const own = signalIn(text, false);
  if (own) return { file, system: true, reason: `signal ${own.name} in test` };
  const same = sameNameModule(file);
  const sameText = same === undefined ? undefined : readIfExists(root, same);
  if (same !== undefined && sameText !== undefined) {
    const sameHit = signalIn(sameText, false);
    if (sameHit) return { file, system: true, reason: `signal ${sameHit.name} in ${same}` };
  }
  for (const other of importedModules(root, file, text)) {
    const otherText = readIfExists(root, other);
    const hit = otherText === undefined ? undefined : signalIn(otherText, true);
    if (hit) return { file, system: true, reason: `signal ${hit.name} in ${other}` };
  }
  return { file, system: false, reason: 'no signal' };
}

/** Classifies a list of test files, in order. */
export function classifyTests(root: string, files: readonly string[]): Verdict[] {
  return files.map((file) => classifyTest(root, file));
}
