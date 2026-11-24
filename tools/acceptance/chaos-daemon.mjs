// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- a plain script that imports the compiled packages and the harness at run time: there are no types to check against */
// The test daemon of the chaos roteiro of the owner (Phase 11, P11). Started by `chaos.sh`, never by hand.
//
// A standalone process, so the owner can `kill -9` it, `kill -STOP` its clients, and start it again on the
// same folders. It is the daemon of `packages/daemon/src/recovery/crash-child-fixture.ts` (the harness of
// P1) with a real clock and a folder the owner drives. Nothing here is the product: the product code is
// the compiled `dist` of the packages, loaded as it is.
//
//   node chaos-daemon.mjs <run dir>
//
// What it reads from `<run dir>` (all made by `chaos.sh`):
// - `config.yaml`: the config of the daemon (`faults.inject: plan` and the fake Executor are in it);
// - `data/`, `state/` (`FAKE_AGENT_STATE_DIR`, with `pids/`), `repo/` (the git repository of the plays);
// - `code-host.jsonl`: the journal of the fake code host (it survives a restart; the fake keeps its state in memory);
// - `ledger.jsonl`: what this process saw committed (events and side effects), written and fsynced before
//   anything counts it as confirmed (the ledger of I2 and I8);
// - `provider-mode`: `ok` (default), `down`, `quota` or `auth`. It is read at every launch of a client, and
//   what it says replaces the script of the fake agent for that launch: `down` is `fail-transient` (a
//   provider that is down or a network that is cut: the error the three clients normalize to `transient`),
//   `quota` is `fail-quota`, `auth` is `fail-auth`. A client that is already running is not touched;
// - `control/`: commands, one file each, named `<seq>-<command>`: `play <need tokens>`, `chat <text>`
//   (`\n` is a line break), `status`. Each answer is `<file>.done` (JSON).
//
// It writes `STARTED` on stdout when the daemon is up, `daemon.pid` in the run dir, and
// `state/pids/daemon-<n>.pid` (the census of the roteiro reads it). It ends by itself after
// `OT_CHAOS_MAX_MINUTES` minutes (default 120), so a forgotten run does not stay behind.
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
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runDir = process.argv[2];
if (runDir === undefined || !existsSync(join(runDir, 'config.yaml'))) {
  process.stderr.write('usage: chaos-daemon.mjs <run dir> (made by chaos.sh)\n');
  process.exit(2);
}
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const dist = join(repoRoot, 'packages', 'daemon', 'dist');
const testing = await import(
  pathToFileURL(join(repoRoot, 'packages', 'core', 'dist', 'testing', 'index.js')).href
);
const fakeAgent = join(repoRoot, 'packages', 'fake-agent', 'dist', 'cli.js');
const { startDaemon } = await import(pathToFileURL(join(dist, 'daemon.js')).href);
const { defaultLauncher, productionClients } = await import(
  pathToFileURL(join(dist, 'compose.js')).href
);
const { parseConfig } = await import(pathToFileURL(join(dist, 'config.js')).href);

const dataDir = join(runDir, 'data');
const stateDir = join(runDir, 'state');
const repo = join(runDir, 'repo');
const journalPath = join(runDir, 'code-host.jsonl');
const ledgerPath = join(runDir, 'ledger.jsonl');
const controlDir = join(runDir, 'control');
const providerFile = join(runDir, 'provider-mode');

mkdirSync(join(stateDir, 'pids'), { recursive: true });
mkdirSync(controlDir, { recursive: true });
writeFileSync(join(runDir, 'daemon.pid'), `${process.pid}\n`);

// The fake code host keeps its state in memory: every change goes to a journal first, and the next
// daemon replays it (the same arrangement as the harness; test only, the real adapter is not touched).
const fake = new testing.FakeCodeHost();
const journal = (entry) => {
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
};
if (existsSync(journalPath)) {
  const lines = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
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
} else {
  fake.seedRemote(repo, 'main');
  journal({ op: 'seedRemote', repo, branch: 'main' });
}
const codeHost = {
  id: fake.id,
  implements: fake.implements,
  async pushRef(target) {
    const sha = execFileSync('git', ['rev-parse', `refs/heads/${target.branch}`], {
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

/** The failure scripts of the fake agent that `provider-mode` stands for. */
const PROVIDER_SCRIPTS = { down: 'fail-transient', quota: 'fail-quota', auth: 'fail-auth' };

function providerMode() {
  try {
    return readFileSync(providerFile, 'utf8').trim() || 'ok';
  } catch {
    return 'ok';
  }
}

/** The launcher of the platform, with the provider switch in front of `launch`. Everything else is the real one. */
function withProviderSwitch(launcher) {
  return new Proxy(launcher, {
    get(target, prop) {
      if (prop === 'launch') {
        return (opts) => {
          const script = PROVIDER_SCRIPTS[providerMode()];
          const env = script === undefined ? opts.env : { ...opts.env, FAKE_AGENT_SCRIPT: script };
          return target.launch({ ...opts, env });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const config = parseConfig(readFileSync(join(runDir, 'config.yaml'), 'utf8'));
const daemon = await startDaemon({
  dataDir,
  config,
  overrides: {
    // The clock is the real one (the roteiro waits real seconds); the vault is memory only, so the
    // keyring of the machine is never touched.
    vault: new testing.InMemorySecretVault(),
    launcher: withProviderSwitch(defaultLauncher()),
    codeHost,
  },
  clients: (parts) => [
    ...productionClients(config)(parts),
    new testing.FakeClientAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      env: {
        FAKE_AGENT_SCRIPT: 'role-play',
        FAKE_AGENT_STATE_DIR: stateDir,
        // Like a real client, the fake agent outlives the daemon that dies: this is what the
        // reconciliation of the next start has to find and end.
        FAKE_AGENT_SURVIVE_EOF: '1',
      },
      adapterVersion: '1.0.0',
      command: { cmd: process.execPath, args: [fakeAgent] },
    }),
  ],
  version: '0.0.0-chaos-roteiro',
});

// A start is counted once it is up (`daemon.recovered` is committed by then): I6 asks for one account of
// the reconciliation per start, and a daemon that a fault plan kills before it is up wrote none.
const boots = readdirSync(join(stateDir, 'pids')).filter((name) =>
  name.startsWith('daemon-'),
).length;
writeFileSync(join(stateDir, 'pids', `daemon-${boots + 1}.pid`), `${process.pid}\n`);

// The ledger of I2 and I8: written and fsynced before anything can count a commit as confirmed.
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
      if (lines.length === 0) return;
      const fd = openSync(ledgerPath, 'a');
      try {
        appendFileSync(fd, `${lines.join('\n')}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    })
    .catch(() => undefined);
  return polling;
}
setInterval(() => void confirmNew(), 50).unref();

// The control folder: the owner (through chaos.sh) asks for a play or a chat, and reads the answer.
async function control(command, argument) {
  if (command === 'play' || command === 'chat') {
    const { scenarioId } = await daemon.producer.openChat({ repo });
    const text =
      command === 'play'
        ? `#ot-play write alpha and beta #outcome:approved ${argument}`
        : argument.replaceAll('\\n', '\n');
    await daemon.producer.send(scenarioId, text);
    return { scenarioId };
  }
  if (command === 'status') return {};
  throw new Error(`unknown command: ${command}`);
}
const done = new Set();
let busy = false;
async function drainControl() {
  if (busy) return;
  busy = true;
  try {
    for (const name of readdirSync(controlDir).sort()) {
      if (name.endsWith('.done') || done.has(name)) continue;
      done.add(name);
      const path = join(controlDir, name);
      const [command, ...rest] = readFileSync(path, 'utf8').trim().split(' ');
      let answer = {};
      try {
        answer = await control(command, rest.join(' '));
      } catch (error) {
        answer = { error: String(error) };
      }
      writeFileSync(
        `${path}.done`,
        JSON.stringify({ ...answer, paused: daemon.disk.paused(), disk: daemon.disk.status() }),
      );
      unlinkSync(path);
    }
  } finally {
    busy = false;
  }
}
setInterval(() => void drainControl(), 100).unref();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await confirmNew();
  await daemon.stop();
  process.stdout.write('STOPPED\n');
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
void daemon.stopped.then(() => {
  process.stdout.write('STOPPED\n');
  process.exit(0);
});
process.stdout.write('STARTED\n');

// A forgotten run ends by itself.
const maxMinutes = Number(process.env.OT_CHAOS_MAX_MINUTES ?? '120');
await sleep(maxMinutes * 60_000);
await stop();
