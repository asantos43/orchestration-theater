// SPDX-License-Identifier: MPL-2.0
// Shared by the `kill -9` test only (excluded from the build of the package).

/**
 * The program of the daemon the chaos harness starts as a CHILD process (an ES module, run with
 * `node`; `chaos/harness.ts` writes it to the folder of the run and starts it). It imports the
 * compiled packages, so `pnpm build` comes first. What it takes from the environment:
 * - `OT_CHILD_MODE`: `first` opens a chat and sends the Producer's message; `resume` only starts
 *   and waits for the play to end;
 * - `OT_CHILD_DATA_DIR`, `OT_CHILD_REPO`, `OT_CHILD_JOURNAL`, `OT_CHILD_STATE_DIR`: the folders;
 * - `OT_CHILD_LEDGER`: the file where it writes, with `fsync`, the id of every event and side effect
 *   it has seen committed (the ledger of I2 and I8);
 * - `OT_CHILD_HOLD_LAUNCH`, `OT_CHILD_HOLD_AFTER`: a test gate on the client launches (read here and
 *   never by the daemon). The first `OT_CHILD_HOLD_AFTER` launches (default 0) go through; each later
 *   one writes `<OT_CHILD_HOLD_LAUNCH>.held` and waits until the file `OT_CHILD_HOLD_LAUNCH` exists
 *   (the harness never creates it). The `.held` file is the signal a random kill is measured from, so
 *   the kill lands before the client exists whatever the speed of the machine;
 * - `OT_CHILD_INJECT`: the value of `faults.inject` (default `env`; a test sets `off` to prove nothing fires);
 * - `OT_CHILD_DAEMON_DIST`, `OT_CHILD_CORE_TESTING`, `OT_CHILD_FAKE_AGENT`: where the compiled code is;
 * - `OT_CHILD_WAIT`: with `1`, mode `first` goes on, after the Producer's message, to wait for the play
 *   to end and print the report like `resume` (the disk tests: the play must finish in this process);
 * - `OT_CHILD_REAL_LOG`: with `1` the daemon keeps its own log file instead of the silent logger;
 * - `OT_CHILD_EXIT_ON_STOP`: with `1` the process ends, printing `STOPPED`, when the daemon stops by
 *   itself (`disk.on_full: stop`);
 * - `OT_CHILD_DISK_ON_FULL`, `OT_CHILD_DISK_NOTIFY`, `OT_CHILD_DISK_MIN_FREE`, `OT_CHILD_DISK_CHECK_EVERY`:
 *   the keys of the `disk` block of the config (Phase 11, P5), each only when set;
 * - `OT_CHILD_CONTROL`: a folder the test writes commands to, one file each, named
 *   `<seq>-<command>`; the child runs them in order, deletes the file and writes `<name>.done` with
 *   the answer as JSON. Commands: `cap <pages>|off` (the store may grow by that many pages: the
 *   `max_page_count` mechanism), `fault <point[:detail]=CODE[#n[xTimes]]>` and `fault-off` (the fail
 *   points), `fill <dir>` and `free <dir>` (a ballast file that takes the free space of a small
 *   file system the test mounted, and gives it back), `log` (one line of the daemon log: with an
 *   armed `fs.write:log` fault, the write that fails), `open-play` (asks to open a play: the gate of
 *   the full disk answers `disk_full`), `status` (the state of the disk guard);
 * - `OT_TEST_CRASH_AT=<point>[:<detail>][#n]`: with `faults.inject: env` in its config (the one key
 *   this program sets for it), the daemon kills itself at that named point (`chaos/crash-points.ts`)
 *   after writing `CRASHPOINT <json>` on stdout, with the pids of its live clients.
 *
 * The code host is the fake one, whose state lives in memory only; here every call that changes it
 * is written to a journal file first and replayed when the next daemon starts, so the code host
 * survives the restart (test only: the real adapter does not change). The fake agent runs with
 * `FAKE_AGENT_SURVIVE_EOF=1`, so it outlives the daemon like a real client would.
 */
export const CRASH_CHILD_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const env = process.env;
const dist = env.OT_CHILD_DAEMON_DIST;
const testing = await import(env.OT_CHILD_CORE_TESTING);
const { startDaemon } = await import(pathToFileURL(dist + '/daemon.js').href);
const { defaultLauncher, productionClients } = await import(pathToFileURL(dist + '/compose.js').href);
const { parseConfig } = await import(pathToFileURL(dist + '/config.js').href);
const { createSilentLogger } = await import(pathToFileURL(dist + '/logger.js').href);
const { armFaults, setCrashDescriber } = await import(pathToFileURL(dist + '/chaos/crash-points.js').href);
const { EMPTY_FAULT_PLAN, parseFailSpec } = await import(pathToFileURL(dist + '/chaos/faults.js').href);
const { openPlayFromNeed } = await import(pathToFileURL(dist + '/orchestration/open-play.js').href);

const fake = new testing.FakeCodeHost();
let daemon;

/**
 * The launcher of the platform, with a test gate in front of launch (see OT_CHILD_HOLD_LAUNCH above).
 * Everything else (the orphan kill included) is the real one.
 */
function gated(launcher) {
  const gate = env.OT_CHILD_HOLD_LAUNCH;
  if (launcher === undefined || gate === undefined || gate === '') return launcher;
  let allowed = Number(env.OT_CHILD_HOLD_AFTER ?? '0');
  return new Proxy(launcher, {
    get(target, prop) {
      if (prop === 'launch') {
        return async (opts) => {
          if (allowed > 0) {
            allowed -= 1;
          } else {
            appendFileSync(gate + '.held', '');
            while (!existsSync(gate)) await sleep(20);
          }
          return target.launch(opts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
    'faults:',
    '  inject: ' + (env.OT_CHILD_INJECT ?? 'env'),
    ...(['ON_FULL', 'NOTIFY', 'MIN_FREE', 'CHECK_EVERY'].some((key) => env['OT_CHILD_DISK_' + key] !== undefined)
      ? [
          'disk:',
          ...['on_full', 'notify', 'min_free', 'check_every']
            .filter((key) => env['OT_CHILD_DISK_' + key.toUpperCase()] !== undefined)
            .map((key) => '  ' + key + ': ' + env['OT_CHILD_DISK_' + key.toUpperCase()]),
        ]
      : []),
  ].join('\n'),
);
daemon = await startDaemon({
  dataDir: env.OT_CHILD_DATA_DIR,
  config,
  overrides: {
    clock: new testing.FakeClock(),
    vault: new testing.InMemorySecretVault(),
    launcher: gated(defaultLauncher()),
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
  // With OT_CHILD_REAL_LOG=1 the daemon writes its own log file (data dir, logs, daemon.log).
  ...(env.OT_CHILD_REAL_LOG === '1' ? {} : { logger: createSilentLogger() }),
  version: '0.0.0-test',
});

// The ledger: what this process has seen committed, written and fsynced before anything else can
// count it as confirmed. A poll sees only committed rows, so a kill never leaves one out.
let lastEventId = 0;
const seenEffects = new Set();
let polling = Promise.resolve();
function confirmNew() {
  polling = polling
    .then(async () => {
      const lines = [];
      for (;;) {
        const batch = await daemon.store.events.readFrom(lastEventId, 500);
        if (batch.length === 0) break;
        for (const event of batch) {
          lines.push(JSON.stringify({ kind: 'event', id: event.id, type: event.type }));
          lastEventId = event.id;
        }
      }
      for (const row of await daemon.store.sideEffects.list({})) {
        if (seenEffects.has(row.idempotencyKey)) continue;
        seenEffects.add(row.idempotencyKey);
        lines.push(JSON.stringify({ kind: 'side_effect', key: row.idempotencyKey }));
      }
      if (lines.length === 0 || env.OT_CHILD_LEDGER === undefined) return;
      const fd = openSync(env.OT_CHILD_LEDGER, 'a');
      try {
        appendFileSync(fd, lines.join('\n') + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    })
    .catch(() => undefined);
  return polling;
}
setInterval(() => void confirmNew(), 20).unref();

// What the crash line carries: the pids of the live clients (the harness checks its census against
// them) and the last poll of the ledger. A store busy in a commit makes the reads wait, and the
// kill does not wait for the describer for more than a couple of seconds.
setCrashDescriber(async () => {
  await confirmNew();
  const rows = await daemon.store.sessions.list({ states: ['active'] });
  return { pids: rows.map((row) => row.pid).filter((pid) => typeof pid === 'number') };
});
process.stdout.write('STARTED\n');
if (env.OT_CHILD_EXIT_ON_STOP === '1') {
  void daemon.stopped.then(() => {
    process.stdout.write('STOPPED\n');
    process.exit(0);
  });
}

// The control folder of the disk tests (see OT_CHILD_CONTROL above).
async function control(command, argument) {
  if (command === 'cap') {
    if (daemon.limitStoreGrowth === undefined) throw new Error('the store cannot be limited here');
    await daemon.limitStoreGrowth(argument === 'off' ? undefined : Number(argument));
  } else if (command === 'fault') {
    armFaults({ crash: [], fail: [parseFailSpec(argument)] });
  } else if (command === 'fault-off') {
    armFaults(EMPTY_FAULT_PLAN);
  } else if (command === 'fill') {
    const fd = openSync(argument + '/ballast', 'w');
    const chunk = Buffer.alloc(64 * 1024, 1);
    try {
      for (;;) writeSync(fd, chunk);
    } catch (error) {
      if (error.code !== 'ENOSPC') throw error;
    } finally {
      closeSync(fd);
    }
  } else if (command === 'log') {
    // One line of the daemon log, on demand: with an armed fs.write:log fault it is the write that fails.
    daemon.logger.warn('chaos: a line of the log');
  } else if (command === 'free') {
    unlinkSync(argument + '/ballast');
  } else if (command === 'open-play') {
    const opened = await openPlayFromNeed(
      { store: daemon.store, runner: daemon.execution.runner, workspace: undefined, config, disk: daemon.disk },
      'no-scenario',
      'a need',
    );
    return { opened: opened.ok, code: opened.ok ? null : opened.code };
  }
  return {};
}
if (env.OT_CHILD_CONTROL !== undefined) {
  mkdirSync(env.OT_CHILD_CONTROL, { recursive: true });
  const done = new Set();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const name of readdirSync(env.OT_CHILD_CONTROL).sort()) {
        if (name.endsWith('.done') || name.endsWith('.tmp') || done.has(name)) continue;
        done.add(name);
        const path = env.OT_CHILD_CONTROL + '/' + name;
        const [command, ...rest] = readFileSync(path, 'utf8').trim().split(' ');
        let answer = {};
        try {
          answer = await control(command, rest.join(' '));
        } catch (error) {
          answer = { error: String(error) };
        }
        const status = daemon.disk.status();
        writeFileSync(path + '.done', JSON.stringify({ ...answer, paused: daemon.disk.paused(), disk: status }));
        unlinkSync(path);
      }
    } finally {
      busy = false;
    }
  }, 20).unref();
}

if (env.OT_CHILD_MODE === 'first') {
  const { scenarioId } = await daemon.producer.openChat({ repo: env.OT_CHILD_REPO });
  await daemon.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  // The test kills this process at the crash point.
  if (env.OT_CHILD_WAIT !== '1') await new Promise(() => undefined);
}

const deadline = Date.now() + Number(env.OT_CHILD_DEADLINE_MS ?? '90000');
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
