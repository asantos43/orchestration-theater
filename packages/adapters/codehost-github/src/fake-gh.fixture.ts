// SPDX-License-Identifier: MPL-2.0

/**
 * Source of a stand-in for the `gh` executable, for the tests of this adapter: the real `gh` never
 * runs in a test (it would talk to GitHub with the credentials of whoever runs the suite). The
 * test writes this text to a temporary file, makes it executable and points `ghBinary` at it.
 *
 * It keeps its state in `FAKE_GH_DIR` (`prs.json`, `issues.json`, `comments.json`, `runs.json`,
 * `logs/<run id>.txt`, and `calls.log` with one JSON line per call: the arguments and the names
 * of the environment variables it saw) and works on the bare
 * repository `FAKE_GH_REMOTE`, with the real `git`, so a merge or a comparison is a real one.
 * Issues and pull requests share one numbering, as on GitHub; the REST answers carry only the
 * fields the adapters read.
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

/** The -f fields of an api call; a key[] repeated makes a list. */
function fields() {
  const out = {};
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-f') continue;
    const raw = args[i + 1];
    const eq = raw.indexOf('=');
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (key.endsWith('[]')) (out[key.slice(0, -2)] = out[key.slice(0, -2)] || []).push(value);
    else if (!(key in out)) out[key] = value;
  }
  return out;
}

function field(name) {
  return fields()[name];
}

function load(name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function save(name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function loadPulls() {
  return load('prs.json');
}

function savePulls(pulls) {
  save('prs.json', pulls);
}

/** Issues and pull requests share one numbering. */
function nextNumber() {
  return Math.max(0, ...loadPulls().map((p) => p.number), ...load('issues.json').map((i) => i.number)) + 1;
}

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

function notFound() {
  fail('gh: Not Found (HTTP 404)');
}

function labelsJson(names) {
  return [...new Set(names)].sort().map((name) => ({ name }));
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
  if (cmd === 'run' && sub === 'view') return runView();
  fail('fake gh: unsupported command: ' + args.join(' '), 2);
}

function prList() {
  const head = flag('--head');
  const base = flag('--base');
  const keys = (flag('--json') || '').split(',');
  const pulls = loadPulls()
    .filter((pull) => pull.headRefName === head && (base === undefined || pull.baseRefName === base))
    .map((pull) => Object.fromEntries(keys.map((key) => [key, pull[key]])));
  out(pulls);
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
  const number = nextNumber();
  const pull = {
    number,
    url: 'https://github.invalid/owner/repo/pull/' + number,
    state: 'OPEN',
    headRefName: head,
    baseRefName: base,
    title: flag('--title'),
    isDraft: args.includes('--draft'),
    createdAt: new Date().toISOString(),
    body: flag('--body') || '',
    author: 'fake-user',
    labels: [],
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
  const method = flag('--method') || 'GET';
  const rest = (endpoint || '').replace('repos/{owner}/{repo}/', '');
  let match;
  if (method === 'GET' && rest === 'issues') return listIssues();
  if (method === 'GET' && (match = /^issues\\/(\\d+)$/.exec(rest))) return out(issueJson(item(match[1])));
  if (method === 'GET' && (match = /^issues\\/(\\d+)\\/comments$/.exec(rest))) return listComments(match[1]);
  if (method === 'POST' && (match = /^issues\\/(\\d+)\\/comments$/.exec(rest))) return comment(match[1]);
  if (method === 'POST' && (match = /^issues\\/(\\d+)\\/labels$/.exec(rest))) return addLabels(match[1]);
  if (method === 'DELETE' && (match = /^issues\\/(\\d+)\\/labels\\/(.+)$/.exec(rest))) {
    return removeLabel(match[1], decodeURIComponent(match[2]));
  }
  if (method === 'GET' && (match = /^pulls\\/(\\d+)$/.exec(rest))) return pullJson(match[1]);
  if (method === 'GET' && rest === 'actions/runs') return listRuns();
  if (method === 'GET' && rest === 'pulls') return listPulls();
  if (method === 'GET' && (match = /^collaborators\\/([^\\/]+)\\/permission$/.exec(rest))) {
    return permission(match[1]);
  }
  fail('fake gh: unsupported api endpoint: ' + method + ' ' + endpoint, 2);
}

/** The issue or pull request with this number, as { kind, value } (404 when there is none). */
function item(number) {
  const n = Number(number);
  const pull = loadPulls().find((p) => p.number === n);
  if (pull) return { kind: 'pull', value: pull };
  const issue = load('issues.json').find((i) => i.number === n);
  if (issue) return { kind: 'issue', value: issue };
  return notFound();
}

/** Saves a changed item back where it came from, with a new updated_at. */
function touch(found) {
  const now = new Date().toISOString();
  if (found.kind === 'pull') {
    savePulls(loadPulls().map((p) => (p.number === found.value.number ? { ...found.value, updatedAt: now } : p)));
  } else {
    save('issues.json', load('issues.json').map((i) => (i.number === found.value.number ? { ...found.value, updated_at: now } : i)));
  }
}

function issueJson(found) {
  const v = found.value;
  if (found.kind === 'pull') {
    return {
      number: v.number,
      html_url: v.url,
      title: v.title,
      body: v.body || null,
      state: v.state === 'OPEN' ? 'open' : 'closed',
      labels: labelsJson(v.labels || []),
      user: { login: v.author || 'fake-user' },
      created_at: v.createdAt,
      updated_at: v.updatedAt || v.createdAt,
      pull_request: { url: v.url },
    };
  }
  return {
    number: v.number,
    html_url: v.url,
    title: v.title,
    body: v.body || null,
    state: v.state,
    labels: labelsJson(v.labels),
    user: v.user === null ? null : { login: v.user },
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

function listIssues() {
  const f = fields();
  const state = f.state || 'open';
  const wanted = f.labels ? f.labels.split(',') : [];
  const since = f.since ? Date.parse(f.since) : undefined;
  const perPage = Number(f.per_page || 30);
  const page = Number(f.page || 1);
  const all = [
    ...loadPulls().map((value) => issueJson({ kind: 'pull', value })),
    ...load('issues.json').map((value) => issueJson({ kind: 'issue', value })),
  ]
    .filter((i) => state === 'all' || i.state === state)
    .filter((i) => wanted.every((label) => i.labels.some((l) => l.name === label)))
    .filter((i) => f.creator === undefined || (i.user && i.user.login === f.creator))
    .filter((i) => since === undefined || Date.parse(i.updated_at) >= since)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.number - a.number);
  out(all.slice((page - 1) * perPage, page * perPage));
}

function listComments(number) {
  const found = item(number);
  const f = fields();
  const page = Number(f.page || 1);
  const perPage = Number(f.per_page || 30);
  const all = load('comments.json')
    .filter((c) => c.number === found.value.number)
    .map((c) => ({ id: c.id, html_url: c.html_url, created_at: c.created_at, body: c.body }));
  out(all.slice((page - 1) * perPage, page * perPage));
}

function comment(number) {
  const found = item(number);
  const body = field('body');
  if (!body) fail('gh: Validation Failed (HTTP 422)');
  const comments = load('comments.json');
  const id = comments.length + 1;
  const created = { id, number: found.value.number, body, html_url: found.value.url + '#issuecomment-' + id, created_at: new Date().toISOString() };
  comments.push(created);
  save('comments.json', comments);
  touch(found);
  out({ id, html_url: created.html_url, created_at: created.created_at });
}

function addLabels(number) {
  const found = item(number);
  const labels = [...new Set([...(found.value.labels || []), ...(fields().labels || [])])].sort();
  if (labels.length !== (found.value.labels || []).length) {
    found.value = { ...found.value, labels };
    touch(found);
  }
  out(labelsJson(labels));
}

function removeLabel(number, label) {
  const found = item(number);
  const labels = found.value.labels || [];
  if (!labels.includes(label)) fail('gh: Label does not exist (HTTP 404)');
  found.value = { ...found.value, labels: labels.filter((l) => l !== label) };
  touch(found);
  out(labelsJson(found.value.labels));
}

function pullJson(number) {
  const found = item(number);
  if (found.kind !== 'pull') return notFound();
  const v = found.value;
  out({
    number: v.number,
    html_url: v.url,
    state: v.state === 'OPEN' ? 'open' : 'closed',
    merged_at: v.state === 'MERGED' ? v.updatedAt || v.createdAt : null,
    draft: v.isDraft,
    title: v.title,
    body: v.body || null,
    created_at: v.createdAt,
    user: { login: v.author || 'fake-user' },
    labels: labelsJson(v.labels || []),
    head: { ref: v.headRefName, sha: sha(v.headRefName) || '0'.repeat(40) },
    base: { ref: v.baseRefName },
  });
}

function listPulls() {
  const f = fields();
  const perPage = Number(f.per_page || 30);
  const page = Number(f.page || 1);
  const all = loadPulls()
    .filter((p) => p.state === 'OPEN')
    .map((v) => ({
      number: v.number,
      user: { login: v.author || 'fake-user' },
      labels: labelsJson(v.labels || []),
      head: { sha: sha(v.headRefName) || '0'.repeat(40) },
      created_at: v.createdAt,
      updated_at: v.updatedAt || v.createdAt,
    }))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.number - a.number);
  out(all.slice((page - 1) * perPage, page * perPage));
}

/** collaborators.json: [{ login, permission }]; a login that is not there is not a user (404). */
function permission(login) {
  const found = load('collaborators.json').find((c) => c.login === login);
  if (!found) return notFound();
  out({ permission: found.permission, user: { login } });
}

function listRuns() {
  const headSha = field('head_sha');
  const runs = load('runs.json').filter((run) => headSha === undefined || run.head_sha === headSha);
  out({ total_count: runs.length, workflow_runs: runs });
}

function runView() {
  const id = args[2];
  const file = path.join(dir, 'logs', id + '.txt');
  if (!args.includes('--log-failed')) fail('fake gh: run view needs --log-failed', 2);
  if (!fs.existsSync(file)) fail('could not find any workflow run with ID ' + id);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
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
