// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- a plain script that imports the compiled packages and the harness at run time: there are no types to check against */
// The verifier of the chaos roteiro of the owner (Phase 11, P11). Run by `chaos.sh`, never needed by hand.
//
//   node chaos-check.mjs <command> <run dir> [options]
//
// It reuses the invariants I1 to I8 and the census of processes of the chaos harness
// (`packages/daemon/src/chaos/invariants.ts` and `census.ts`), loaded from their sources: the harness is
// test code and is not in `dist`, so a resolve hook (`chaos-ts-hook.mjs`) lets Node 24, which strips the
// types by itself, import the `.ts` files as they are. No invariant is written again here; if one changes
// in the harness, the roteiro changes with it.
//
// Commands:
// - `check [--wait <s>] [--allow <STATE,STATE>]`: the invariants. Prints one line per invariant, then
//   `ok` or `falhou: <reason>` (exit 0 or 1). Waits up to `--wait` seconds (default 90) for every play
//   to be in a state of `--allow` (default `DONE`), which is what I6 asks of a run;
// - `census-save`: writes `census-before.json` with the processes of the run that are alive now (the
//   census "after the kill" of the harness). `chaos.sh restart` calls it before the new daemon starts,
//   and I3 asks that none of them is alive after the recovery;
// - `pids`: the daemon and the clients, one per line (`daemon <pid> <state>`, `cliente <pid> <state> <executor|diretor/conversa>`);
// - `plays` and `events [n]`: what the store says (the state of each play; the last events);
// - `leftovers`: the processes of the run that are alive, one per line;
// - `kill-leftovers`: ends them with SIGKILL (by the census, never by a pattern) and says which.
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// eslint-disable-next-line @typescript-eslint/no-deprecated -- `registerHooks` is in-thread and sync; the async hook file is what is loaded here
register(new URL('./chaos-ts-hook.mjs', import.meta.url));
const chaosDir = join(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..'),
  'packages',
  'daemon',
  'src',
  'chaos',
);
const load = (name) => import(pathToFileURL(join(chaosDir, name)).href);
const census = await load('census.ts');
const invariants = await load('invariants.ts');

process.stdout.on('error', () => process.exit(0));
const [command, runDir, ...rest] = process.argv.slice(2);
if (command === undefined || runDir === undefined || !existsSync(runDir)) {
  process.stderr.write('usage: chaos-check.mjs <command> <run dir> [options]\n');
  process.exit(2);
}
const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1] : fallback;
};

const dataDir = join(runDir, 'data');
const stateDir = join(runDir, 'state');
const storePath = join(dataDir, 'store.sqlite');
const ledger = new invariants.CommitLedger(join(runDir, 'ledger.jsonl'));
const savedPath = join(runDir, 'census-before.json');

/** This process and every process above it (the shell, `timeout`, `nsenter`): the census must not count them. */
function ancestry() {
  const pids = [process.pid];
  for (let pid = process.ppid; pid > 1;) {
    pids.push(pid);
    const info = census.readProc(pid);
    if (info === undefined) break;
    pid = info.ppid;
  }
  return pids;
}
const takeCensus = () => census.takeCensus({ runDir, stateDir, storePath, exclude: ancestry() });

const aliveNow = () => census.aliveEntries(takeCensus());
const unique = (entries) => [...new Map(entries.map((entry) => [entry.pid, entry])).values()];

function stateOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 2, text.lastIndexOf(')') + 3);
  } catch {
    return '?';
  }
}

/** What a client does, read from its folder: an Actor works in a worktree of the play, the Director in the repository. */
function roleOf(pid) {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    if (cwd.startsWith(join(dataDir, 'worktrees'))) return 'executor';
    return cwd.startsWith(join(runDir, 'repo')) ? 'diretor/conversa' : 'outro';
  } catch {
    return '?';
  }
}

function daemonPid() {
  try {
    return Number(readFileSync(join(runDir, 'daemon.pid'), 'utf8').trim());
  } catch {
    return undefined;
  }
}

function readStore(sql) {
  if (!existsSync(storePath)) return [];
  const db = new DatabaseSync(storePath);
  try {
    db.exec('PRAGMA query_only = ON');
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** What I6 reads (the `REPORT` of the harness), made from the store of the run. */
async function runReport(allowed, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let plays;
  let timedOut = false;
  for (;;) {
    plays = readStore('SELECT id, state FROM plays');
    if (plays.every((play) => allowed.includes(play.state))) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await sleep(500);
  }
  const events = readStore(
    "SELECT type, scenario_id, payload FROM events WHERE type IN ('daemon.recovered', 'scenario.system_message') ORDER BY id",
  );
  // Each start writes its daemon.recovered before its messages: the count so far is the start.
  let boot = 0;
  const booted = events.map((event) => {
    if (event.type === 'daemon.recovered') boot += 1;
    return { ...event, boot };
  });
  return {
    timedOut,
    plays,
    recovered: events.filter((event) => event.type === 'daemon.recovered'),
    systemMessages: booted
      .filter((event) => event.type === 'scenario.system_message')
      .map((event) => ({
        scenarioId: event.scenario_id,
        payload: event.payload,
        boot: event.boot,
      })),
  };
}

if (command === 'census-save') {
  const alive = aliveNow();
  writeFileSync(savedPath, JSON.stringify({ entries: alive }));
  const pids = unique(alive).map((entry) => entry.pid);
  process.stdout.write(
    `${String(pids.length)} processo(s) da execução anterior ainda vivos: ${pids.join(' ')}\n`,
  );
} else if (command === 'pids') {
  const daemon = daemonPid();
  if (daemon !== undefined && census.isAlive(daemon)) {
    process.stdout.write(`daemon ${String(daemon)} ${stateOf(daemon)}\n`);
  }
  for (const entry of unique(aliveNow())) {
    if (entry.pid === daemon) continue;
    process.stdout.write(
      `cliente ${String(entry.pid)} ${stateOf(entry.pid)} ${roleOf(entry.pid)}\n`,
    );
  }
} else if (command === 'plays') {
  const plays = readStore('SELECT id, state FROM plays');
  process.stdout.write(
    plays.length === 0
      ? 'nenhum play\n'
      : plays.map((play) => `play ${play.id} ${play.state}\n`).join(''),
  );
} else if (command === 'events') {
  const limit = Number(rest[0] ?? '12');
  const rows = readStore(
    `SELECT id, type, payload FROM events ORDER BY id DESC LIMIT ${String(limit)}`,
  );
  for (const row of rows.reverse()) {
    process.stdout.write(`evento ${row.id} ${row.type} ${String(row.payload).slice(0, 90)}\n`);
  }
} else if (command === 'leftovers' || command === 'kill-leftovers') {
  const entries = unique(aliveNow());
  for (const entry of entries) {
    process.stdout.write(`${String(entry.pid)} ${entry.source}: ${entry.detail}\n`);
    if (command === 'kill-leftovers') {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Gone in the meantime.
      }
    }
  }
} else if (command === 'check') {
  const allowed = option('--allow', 'DONE').split(',');
  const waitSeconds = Number(option('--wait', '90'));
  const boots = readdirSync(join(stateDir, 'pids')).filter((name) =>
    name.startsWith('daemon-'),
  ).length;
  const report = await runReport(allowed, waitSeconds);
  // I3 is about the processes the kill left: the census `restart` took before the new daemon, none of
  // which may be alive now. With no kill on record there is nothing to compare against.
  const before = existsSync(savedPath)
    ? JSON.parse(readFileSync(savedPath, 'utf8'))
    : { entries: [] };
  const results = [
    invariants.checkI1({ dataDir }),
    invariants.checkI2({ storePath, ledger }),
    invariants.checkI3(before),
    invariants.checkI4(invariants.readCodeHostJournal(join(runDir, 'code-host.jsonl'))),
    invariants.checkI5({ storePath }),
    invariants.checkI6(report, { boots, explainedStates: allowed }),
    // While the daemon lives it holds the instance lock inside a transaction, so SQLite keeps the rollback
    // journal of that lock beside it (the same allowance as `app-update.chaos.test.ts`); after it, it is a leftover.
    invariants.checkI7({
      root: runDir,
      allowed:
        daemonPid() !== undefined && census.isAlive(daemonPid())
          ? [...invariants.DEFAULT_ALLOWED_LEFTOVERS, /^daemon\.lock-journal$/]
          : invariants.DEFAULT_ALLOWED_LEFTOVERS,
    }),
    invariants.checkI8({ storePath, ledger }),
  ];
  for (const entry of results) {
    process.stdout.write(
      entry.ok ? `  ${entry.id} ok\n` : `  ${entry.id} falhou: ${entry.problems.join('; ')}\n`,
    );
  }
  const failed = results.filter((entry) => !entry.ok);
  if (failed.length === 0) {
    process.stdout.write('ok\n');
  } else {
    process.stdout.write(
      `falhou: ${failed.map((entry) => `${entry.id}: ${entry.problems[0]}`).join(' | ')}\n`,
    );
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
