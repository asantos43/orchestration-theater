// SPDX-License-Identifier: MPL-2.0

/**
 * Source of a stand-in for the `gh` executable, for the tests of this adapter: the real `gh` never
 * runs in a test (it would talk to GitHub with the credentials of whoever runs the suite). The
 * test writes this text to a temporary file, makes it executable and points `ghBinary` at it.
 *
 * It keeps its state in `FAKE_GH_DIR` (`prs.json`, and `calls.log` with one JSON line per call:
 * the arguments and the names of the environment variables it saw) and works on the bare
 * repository `FAKE_GH_REMOTE`, with the real `git`, so a merge or a comparison is a real one.
 * `FAKE_GH_FAIL` makes every call fail the way the named failure does (`auth`, `http500`);
 * `FAKE_GH_HANG=1` makes it never end.
 */
export const FAKE_GH_SOURCE = `#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
const remote = process.env.FAKE_GH_REMOTE;
fs.appendFileSync(
  path.join(dir, 'calls.log'),
  JSON.stringify({ args, env: Object.keys(process.env).sort() }) + '\\n',
);

function fail(message, code = 1) {
  process.stderr.write(message + '\\n');
  process.exit(code);
}

if (process.env.FAKE_GH_HANG === '1') setInterval(() => undefined, 1000);
else main();

function git(cwd, ...gitArgs) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fake Host', '-c', 'user.email=host@localhost', '-c', 'core.hooksPath=/dev/null', ...gitArgs],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function tryGit(cwd, ...gitArgs) {
  try {
    return { ok: true, out: git(cwd, ...gitArgs) };
  } catch (error) {
    return { ok: false, out: String(error.stderr || error.message) };
  }
}

function sha(branch) {
  const result = tryGit(remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch + '^{commit}');
  return result.ok ? result.out : undefined;
}

function flag(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function field(name) {
  const index = args.findIndex((arg, i) => arg === '-f' && args[i + 1].startsWith(name + '='));
  return index < 0 ? undefined : args[index + 1].slice(name.length + 1);
}

function loadPulls() {
  const file = path.join(dir, 'prs.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function savePulls(pulls) {
  fs.writeFileSync(path.join(dir, 'prs.json'), JSON.stringify(pulls));
}

function main() {
  if (process.env.FAKE_GH_FAIL === 'auth') {
    fail('To get started with GitHub CLI, please run:  gh auth login', 4);
  }
  if (process.env.FAKE_GH_FAIL === 'http500') fail('gh: Server Error (HTTP 500)');
  const [cmd, sub] = args;
  if (cmd === 'pr' && sub === 'list') return prList();
  if (cmd === 'pr' && sub === 'create') return prCreate();
  if (cmd === 'api') return api();
  fail('fake gh: unsupported command: ' + args.join(' '), 2);
}

function prList() {
  const head = flag('--head');
  const base = flag('--base');
  const pulls = loadPulls().filter(
    (pull) => pull.headRefName === head && (base === undefined || pull.baseRefName === base),
  );
  process.stdout.write(JSON.stringify(pulls));
}

function prCreate() {
  const head = flag('--head');
  const base = flag('--base');
  const pulls = loadPulls();
  if (sha(head) === undefined) {
    fail("pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)");
  }
  const open = pulls.find((p) => p.state === 'OPEN' && p.headRefName === head && p.baseRefName === base);
  if (open) {
    fail('a pull request for branch "' + head + '" into branch "' + base + '" already exists:\\n' + open.url);
  }
  const number = pulls.length + 1;
  const pull = {
    number,
    url: 'https://github.invalid/owner/repo/pull/' + number,
    state: 'OPEN',
    headRefName: head,
    baseRefName: base,
    title: flag('--title'),
    isDraft: args.includes('--draft'),
    createdAt: new Date().toISOString(),
  };
  pulls.push(pull);
  savePulls(pulls);
  process.stdout.write(pull.url + '\\n');
}

function api() {
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  const merges = endpoint === 'repos/{owner}/{repo}/merges';
  if (merges) return merge();
  const compare = /^repos\\/\\{owner\\}\\/\\{repo\\}\\/compare\\/(.+)\\.\\.\\.(.+)$/.exec(endpoint || '');
  if (compare) return compareBranches(compare[1], compare[2]);
  fail('fake gh: unsupported api endpoint: ' + endpoint, 2);
}

function compareBranches(base, head) {
  const baseSha = sha(base);
  const headSha = sha(head);
  if (baseSha === undefined || headSha === undefined) fail('gh: Not Found (HTTP 404)');
  const headInBase = tryGit(remote, 'merge-base', '--is-ancestor', headSha, baseSha).ok;
  const baseInHead = tryGit(remote, 'merge-base', '--is-ancestor', baseSha, headSha).ok;
  let status = 'diverged';
  if (baseSha === headSha) status = 'identical';
  else if (headInBase) status = 'behind';
  else if (baseInHead) status = 'ahead';
  process.stdout.write(status + '\\n');
}

function merge() {
  const base = field('base');
  const head = field('head');
  const baseSha = sha(base);
  const headSha = sha(head);
  if (baseSha === undefined || headSha === undefined) fail('gh: Not Found (HTTP 404)');
  if (tryGit(remote, 'merge-base', '--is-ancestor', headSha, baseSha).ok) return;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-merge-'));
  try {
    git(work, 'clone', '--quiet', '--no-local', remote, 'clone');
    const clone = path.join(work, 'clone');
    git(clone, 'checkout', '--quiet', base);
    const result = tryGit(clone, 'merge', '--no-ff', '-m', field('commit_message') || 'Merge ' + head, 'origin/' + head);
    if (!result.ok) fail('gh: Merge conflict (HTTP 409)');
    git(clone, 'push', '--quiet', 'origin', base);
    process.stdout.write(git(clone, 'rev-parse', 'HEAD') + '\\n');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
`;
