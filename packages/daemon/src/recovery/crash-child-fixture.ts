// SPDX-License-Identifier: MPL-2.0
// Shared by the `kill -9` test only (excluded from the build of the package).

/**
 * The program of the daemon the `kill -9` test starts as a CHILD process (an ES module, run with
 * `node`). It imports the compiled packages, so `pnpm build` comes first. What it takes from the
 * environment:
 * - `OT_CHILD_MODE`: `first` opens a chat and sends the Producer's message; `resume` only starts
 *   and waits for the play to end;
 * - `OT_CHILD_DATA_DIR`, `OT_CHILD_REPO`, `OT_CHILD_JOURNAL`, `OT_CHILD_STATE_DIR`: the folders;
 * - `OT_CHILD_DAEMON_DIST`, `OT_CHILD_CORE_TESTING`, `OT_CHILD_FAKE_AGENT`: where the compiled code is;
 * - `OT_TEST_CRASH_AT=open_pr:after`: the code host opens the pull request, writes it down, tells
 *   the test (`CRASHPOINT <json>` on stdout) and never answers: the effect has started and has no
 *   end, which is the moment the test kills the daemon.
 *
 * The code host is the fake one, whose state lives in memory only; here every call that changes it
 * is written to a journal file first and replayed when the next daemon starts, so the code host
 * survives the restart (test only: the real adapter does not change). The fake agent runs with
 * `FAKE_AGENT_SURVIVE_EOF=1`, so it outlives the daemon like a real client would.
 */
export const CRASH_CHILD_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const env = process.env;
const dist = env.OT_CHILD_DAEMON_DIST;
const testing = await import(env.OT_CHILD_CORE_TESTING);
const { startDaemon } = await import(pathToFileURL(dist + '/daemon.js').href);
const { defaultLauncher, productionClients } = await import(pathToFileURL(dist + '/compose.js').href);
const { parseConfig } = await import(pathToFileURL(dist + '/config.js').href);
const { createSilentLogger } = await import(pathToFileURL(dist + '/logger.js').href);

const fake = new testing.FakeCodeHost();
let daemon;

function journal(entry) {
  appendFileSync(env.OT_CHILD_JOURNAL, JSON.stringify(entry) + '\n');
}

async function replay() {
  if (!existsSync(env.OT_CHILD_JOURNAL)) return;
  const lines = readFileSync(env.OT_CHILD_JOURNAL, 'utf8').split('\n').filter((line) => line !== '');
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.op === 'seedRemote') fake.seedRemote(entry.repo, entry.branch);
    if (entry.op === 'pushRef') {
      fake.adoptLocal(entry.target.repo, entry.target.branch, entry.sha);
      await fake.pushRef(entry.target);
    }
    if (entry.op === 'openPullRequest') await fake.openPullRequest(entry.opts);
    if (entry.op === 'mergeBranch') await fake.mergeBranch(entry.opts);
  }
}

/** The fake code host with its changes written to the journal; pushes use the real heads. */
const codeHost = {
  id: fake.id,
  implements: fake.implements,
  async pushRef(target) {
    const sha = execFileSync('git', ['rev-parse', 'refs/heads/' + target.branch], {
      cwd: target.repo,
      encoding: 'utf8',
    }).trim();
    fake.adoptLocal(target.repo, target.branch, sha);
    const result = await fake.pushRef(target);
    journal({ op: 'pushRef', target, sha });
    return result;
  },
  remoteRef: (target) => fake.remoteRef(target),
  async openPullRequest(opts) {
    const pull = await fake.openPullRequest(opts);
    journal({ op: 'openPullRequest', opts });
    if (env.OT_TEST_CRASH_AT === 'open_pr:after') {
      const rows = await daemon.store.sessions.list({ states: ['active'] });
      const pids = rows.map((row) => row.pid).filter((pid) => typeof pid === 'number');
      process.stdout.write('CRASHPOINT ' + JSON.stringify({ pids }) + '\n');
      await new Promise(() => undefined);
    }
    return pull;
  },
  findPullRequest: (opts) => fake.findPullRequest(opts),
  async mergeBranch(opts) {
    const result = await fake.mergeBranch(opts);
    journal({ op: 'mergeBranch', opts });
    return result;
  },
  isBranchMerged: (opts) => fake.isBranchMerged(opts),
};

if (existsSync(env.OT_CHILD_JOURNAL)) {
  await replay();
} else {
  fake.seedRemote(env.OT_CHILD_REPO, 'main');
  journal({ op: 'seedRemote', repo: env.OT_CHILD_REPO, branch: 'main' });
}

const config = parseConfig(
  [
    'backup:',
    '  when: manual',
    'security:',
    '  unenforced: warn',
    'limits:',
    '  submit_retries: 1',
    'orchestration:',
    '  executor:',
    '    client: fake',
    '    profile: one',
    '    model: fake-model',
  ].join('\n'),
);
daemon = await startDaemon({
  dataDir: env.OT_CHILD_DATA_DIR,
  config,
  overrides: {
    clock: new testing.FakeClock(),
    vault: new testing.InMemorySecretVault(),
    launcher: defaultLauncher(),
    codeHost,
  },
  clients: (parts) => [
    ...productionClients(config)(parts),
    new testing.FakeClientAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      env: {
        FAKE_AGENT_SCRIPT: 'role-play',
        FAKE_AGENT_STATE_DIR: env.OT_CHILD_STATE_DIR,
        FAKE_AGENT_SURVIVE_EOF: '1',
      },
      adapterVersion: '1.0.0',
      command: { cmd: process.execPath, args: [env.OT_CHILD_FAKE_AGENT] },
    }),
  ],
  logger: createSilentLogger(),
  version: '0.0.0-test',
});
process.stdout.write('STARTED\n');

if (env.OT_CHILD_MODE === 'first') {
  const { scenarioId } = await daemon.producer.openChat({ repo: env.OT_CHILD_REPO });
  await daemon.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  // The test kills this process at the crash point.
  await new Promise(() => undefined);
}

const deadline = Date.now() + 90000;
let timedOut = false;
for (;;) {
  const plays = await daemon.store.plays.list({});
  if (plays.length > 0 && plays.every((play) => play.state === 'DONE')) break;
  if (Date.now() > deadline) {
    timedOut = true;
    break;
  }
  await sleep(50);
}
const events = await daemon.store.events.readFrom(0, 100000);
const report = {
  timedOut,
  plays: (await daemon.store.plays.list({})).map((play) => ({ id: play.id, state: play.state })),
  systemMessages: events
    .filter((event) => event.type === 'scenario.system_message')
    .map((event) => ({ scenarioId: event.scenarioId ?? null, payload: event.payload })),
  recovered: events.filter((event) => event.type === 'daemon.recovered').map((event) => event.payload),
  events: events.map((event) => ({ type: event.type, playId: event.playId ?? null })),
  sideEffects: (await daemon.store.sideEffects.list({})).map((row) => ({
    key: row.idempotencyKey,
    type: row.type,
    state: row.state,
    verifier: row.verifier,
  })),
  decisions: (await daemon.store.decisions.list({})).map((row) => ({ kind: row.kind, state: row.state })),
  pulls: fake.pullRequests().length,
};
process.stdout.write('REPORT ' + JSON.stringify(report) + '\n');
await daemon.stop();
process.exit(0);
`;
