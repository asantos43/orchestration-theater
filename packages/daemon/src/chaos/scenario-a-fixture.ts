// SPDX-License-Identifier: MPL-2.0
// Part of the chaos tests of Phase 11, P3 (excluded from the build of the package).
import { existsSync } from 'node:fs';
import {
  ChatServerMessageSchema,
  type ChatClientMessage,
  type ChatServerMessage,
} from '@otheater/protocol';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { CRASHPOINT_LINE } from './crash-points.js';
import { aliveEntries, type Census } from './census.js';
import type { ChaosRig, ChildDaemon, CrashLine, RunReport } from './harness.js';
import { assertInvariants, checkI3 } from './invariants.js';
import { snapshotStore, tearStore, type Tear } from './torn-store.js';
import { CRASH_CHILD_SCRIPT } from '../recovery/crash-child-fixture.js';

/**
 * The child daemon of the P3 chaos tests: the program of P1 ({@link CRASH_CHILD_SCRIPT}) with four
 * more test knobs, added by replacing text of that program (each replacement is checked, so a
 * change of the original that moves the text fails loudly here and not silently in a test).
 *
 * - `OT_CHILD_WINDOW_GATE`, `OT_CHILD_WINDOW_SKIP`: a gate AFTER a client launch (it needs `OT_CHILD_HOLD_LAUNCH` set to any path and `OT_CHILD_HOLD_AFTER` large, so the gate before the launch never holds). The first
 *   `OT_CHILD_WINDOW_SKIP` launches go through; each later one writes `<gate>.spawned` (the pid of
 *   the client) and waits until the file `<gate>` exists. The launcher has returned the process and
 *   the tracking has not yet written its pid: the window of the defect P3 fixes. The harness never
 *   creates the file, it kills the daemon instead;
 * - `API {"url": ...}` line after `STARTED`: where the API of the daemon listens;
 * - `OT_CHILD_MODE=chat`: opens a chat, prints `SCENARIO <id>` and waits; the test sends the
 *   Producer's message through the chat WebSocket;
 * - `OT_CHILD_KEEP_UP=<file>`: in `resume` mode the daemon prints its report and stays up (the API
 *   too) until that file exists, so a client can reconnect to it;
 * - `OT_CHILD_ORPHANS`: the value of `recovery.orphans` (default `kill`);
 * - `OT_CHILD_NO_PLAY=1`: in `resume` mode it does not wait for a play to end (the kill came before
 *   any play was written, so none will ever be).
 */

function replaceOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) {
    throw new Error(
      `crash-child-fixture changed: ${JSON.stringify(from)} is not there exactly once`,
    );
  }
  return text.replace(from, () => to);
}

let script = CRASH_CHILD_SCRIPT;

// 1. The gate after the launch.
script = replaceOnce(
  script,
  '          return target.launch(opts);',
  `          const launched = await target.launch(opts);
          if (env.OT_CHILD_WINDOW_GATE !== undefined) {
            if (windowSkip > 0) {
              windowSkip -= 1;
            } else {
              appendFileSync(env.OT_CHILD_WINDOW_GATE + '.spawned', String(launched.pid) + '\\n');
              while (!existsSync(env.OT_CHILD_WINDOW_GATE)) await sleep(20);
            }
          }
          return launched;`,
);
script = replaceOnce(
  script,
  "  let allowed = Number(env.OT_CHILD_HOLD_AFTER ?? '0');",
  `  let allowed = Number(env.OT_CHILD_HOLD_AFTER ?? '0');
  let windowSkip = Number(env.OT_CHILD_WINDOW_SKIP ?? '0');`,
);
// The `recovery.orphans` mode (the window test proves the `report` mode leaves the orphan).
script = replaceOnce(
  script,
  "    'faults:',",
  "    'recovery:',\n    '  orphans: ' + (env.OT_CHILD_ORPHANS ?? 'kill'),\n    'faults:',",
);

// 2. The API line.
script = replaceOnce(
  script,
  "process.stdout.write('STARTED\\n');",
  "process.stdout.write('STARTED\\n');\nprocess.stdout.write('API ' + JSON.stringify({ url: daemon.api.url }) + '\\n');",
);

// 3. The chat mode, before the `first` mode.
script = replaceOnce(
  script,
  "if (env.OT_CHILD_MODE === 'first') {",
  `if (env.OT_CHILD_MODE === 'chat') {
  const { scenarioId } = await daemon.producer.openChat({ repo: env.OT_CHILD_REPO });
  process.stdout.write('SCENARIO ' + JSON.stringify({ scenarioId }) + '\\n');
  await new Promise(() => undefined);
}

if (env.OT_CHILD_MODE === 'first') {`,
);

// 4. The wait of the resume mode.
script = replaceOnce(
  script,
  "  if (plays.length > 0 && plays.every((play) => play.state === 'DONE')) break;",
  `  if (env.OT_CHILD_NO_PLAY === '1' && plays.length === 0) break;
  if (plays.length > 0 && plays.every((play) => play.state === 'DONE')) break;`,
);
script = replaceOnce(
  script,
  "process.stdout.write('REPORT ' + JSON.stringify(report) + '\\n');",
  `process.stdout.write('REPORT ' + JSON.stringify(report) + '\\n');
if (env.OT_CHILD_KEEP_UP !== undefined) {
  while (!existsSync(env.OT_CHILD_KEEP_UP)) await sleep(50);
}`,
);

export const SCENARIO_A_CHILD_SCRIPT = script;

/** The line the child prints with the address of its API. */
export const API_LINE = 'API ';
/** The line the chat mode prints with the id of the scenario it opened. */
export const SCENARIO_LINE = 'SCENARIO ';

/** The number of random instants of each scenario: `OT_CHAOS_INSTANTS`, 50 by default (docs/23, P3). */
export function chaosInstants(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.OT_CHAOS_INSTANTS);
  return Number.isInteger(value) && value > 0 ? value : 50;
}

const STEP_TIMEOUT_MS = 150_000;

/** Waits until `path` exists. */
export async function waitForFile(path: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} did not appear in ${String(timeoutMs)} ms`);
    await sleep(10);
  }
}

/** How many plays the store holds (a store that is not there, or not readable yet: none). */
export function playCount(storePath: string): number {
  if (!existsSync(storePath)) return 0;
  try {
    const db = new DatabaseSync(storePath);
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM plays').get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** The last events of the store, one per line (what a failed verdict prints to say where the plays were). */
export function recentEvents(storePath: string, limit = 30): string {
  try {
    const db = new DatabaseSync(storePath);
    try {
      const rows = db
        .prepare('SELECT id, type, play_id, payload FROM events ORDER BY id DESC LIMIT ?')
        .all(limit) as { id: number; type: string; play_id: string | null; payload: string }[];
      const lines = rows
        .reverse()
        .map(
          (row) =>
            `#${String(row.id)} ${row.type} ${row.play_id ?? '-'} ${row.payload.slice(0, 200)}`,
        )
        .join('\n');
      const effects = db
        .prepare('SELECT * FROM side_effects ORDER BY rowid DESC LIMIT 8')
        .all()
        .map((row) => JSON.stringify(row).slice(0, 300))
        .join('\n');
      return `${lines}\n-- side_effects (last 8)\n${effects}`;
    } finally {
      db.close();
    }
  } catch (error) {
    return `(events not readable: ${String(error)})`;
  }
}

/** What a kill of the whole run left behind (the fields the invariants need). */
export interface Crashed {
  readonly signal: NodeJS.Signals | null;
  readonly crash?: CrashLine | undefined;
  /** The census after the kill and before the next start. */
  readonly census: Census;
  /** The tear of the store, when one was asked for. */
  readonly tear?: Tear | undefined;
}

export interface CrashSpec {
  readonly mode: 'first' | 'chat' | 'resume';
  /** `<point>[:<detail>][#<n>]`: the daemon kills itself there. */
  readonly point?: string | undefined;
  /** Or: `SIGKILL` this long after it said `STARTED`. */
  readonly delayMs?: number | undefined;
  /** Power loss, level i: every process of the run is killed, not only the daemon (the clients die too). */
  readonly wholeTree?: boolean | undefined;
  /** Power loss, level ii: the store is torn after the kill, with this seed (see `torn-store.ts`). */
  readonly tearSeed?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Starts a daemon of this scenario (`chat` is a mode of this fixture: the harness knows `first` and `resume`). */
export function startDaemon(
  rig: ChaosRig,
  mode: CrashSpec['mode'],
  crashAt?: string,
  env: Readonly<Record<string, string>> = {},
): ChildDaemon {
  return rig.start({
    mode: mode === 'chat' ? 'first' : mode,
    ...(crashAt === undefined ? {} : { crashAt }),
    env: { ...(mode === 'chat' ? { OT_CHILD_MODE: 'chat' } : {}), ...env },
  });
}

/** SIGKILLs every process of the census that is alive, until none is (the daemon is dead: nothing new starts). */
export function killTree(rig: ChaosRig): void {
  for (let round = 0; round < 20; round += 1) {
    const alive = aliveEntries(rig.census());
    if (alive.length === 0) return;
    for (const entry of alive) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Gone in the meantime.
      }
    }
  }
}

/**
 * Starts a daemon, kills it at a point or after an instant, and (on request) kills the whole run and
 * tears the store. The census comes after the files of the store were copied: the first connection
 * that opens the store afterwards checkpoints its WAL away.
 */
export async function crashDaemon(rig: ChaosRig, spec: CrashSpec): Promise<Crashed> {
  const child = startDaemon(rig, spec.mode, spec.point, spec.env);
  let crash: CrashLine | undefined;
  if (spec.point !== undefined) {
    crash = (await child.line(CRASHPOINT_LINE, STEP_TIMEOUT_MS)) as CrashLine;
    const late = sleep(10_000).then(() => 'late' as const);
    if ((await Promise.race([child.exited, late])) === 'late') child.process.kill('SIGKILL');
  } else {
    await child.line('STARTED', STEP_TIMEOUT_MS);
    await sleep(spec.delayMs ?? 0);
    child.process.kill('SIGKILL');
  }
  const exit = await child.exited;
  // Before anything reads the store: `killTree` takes a census, and the last connection to close
  // (a census opens one) checkpoints the WAL away.
  const snapshot = spec.tearSeed === undefined ? undefined : snapshotStore(rig.dataDir);
  if (spec.wholeTree === true) killTree(rig);
  const census = rig.census();
  const tear =
    spec.tearSeed === undefined || snapshot === undefined
      ? undefined
      : tearStore({ dataDir: rig.dataDir, snapshot, ledger: rig.ledger, seed: spec.tearSeed });
  return { signal: exit.signal, crash, census, tear };
}

/**
 * Starts the daemon again and waits for its report. If the kill came before any play was written
 * none will ever end, so the child is told not to wait for one.
 */
export async function restartDaemon(
  rig: ChaosRig,
  env: Readonly<Record<string, string>> = {},
): Promise<RunReport> {
  const noPlay = playCount(rig.storePath) === 0;
  const child = rig.start({
    mode: 'resume',
    env: { ...(noPlay ? { OT_CHILD_NO_PLAY: '1' } : {}), ...env },
  });
  const report = (await child.line('REPORT ', STEP_TIMEOUT_MS)) as RunReport;
  await child.exited;
  return report;
}

// --- the chat through the API ----------------------------------------------------------------

/** A chat client of the daemon's WebSocket (the one of `api/chat-socket.e2e.test.ts`, for a child daemon). */
export class ChatSocket {
  readonly frames: ChatServerMessage[] = [];
  /** Resolves with the close code when the connection ends (an end by `SIGKILL` of the daemon is 1006). */
  readonly closed: Promise<number>;
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    socket.addEventListener('message', (event) => {
      this.frames.push(ChatServerMessageSchema.parse(JSON.parse(String(event.data))));
    });
  }

  /** `POST /v1/chat-tickets`, then the socket with its ticket; `resume` is sent first when asked for. */
  static async open(input: {
    readonly apiUrl: string;
    readonly token: string;
    readonly scenarioId: string;
    readonly lastEventId?: number;
  }): Promise<ChatSocket> {
    const answer = await fetch(`${input.apiUrl}/v1/chat-tickets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: input.scenarioId }),
    });
    if (answer.status !== 200) throw new Error(`chat ticket refused: ${String(answer.status)}`);
    const { ticket } = (await answer.json()) as { ticket: string };
    const socket = new WebSocket(
      `${input.apiUrl.replace('http', 'ws')}/v1/scenarios/${input.scenarioId}/chat?ticket=${ticket}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the chat socket did not open'));
      });
    });
    const chat = new ChatSocket(socket);
    if (input.lastEventId !== undefined) {
      chat.send({ type: 'resume', lastEventId: input.lastEventId });
    }
    return chat;
  }

  send(message: ChatClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    this.#socket.close(1000);
  }

  /** The highest `eventId` the client has got: the cursor of its `resume`. */
  get cursor(): number {
    return this.frames.reduce((top, frame) => Math.max(top, frame.eventId ?? 0), 0);
  }

  /** Waits until `check` finds something in the frames. */
  async until<T>(
    what: string,
    check: () => T | undefined,
    timeoutMs = STEP_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = check();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`The chat never got ${what}.`);
      await sleep(20);
    }
  }
}

/**
 * The invariants after the last restart. The census of every kill must be dead (I3), not only the
 * last one. A start killed before its reconciliation wrote nothing, so the starts counted (I6) are the
 * ones whose `daemon.recovered` came out.
 */
export function verdictAfter(
  rig: ChaosRig,
  kills: readonly { readonly census: Census }[],
  report: RunReport,
  options: { readonly atLeastOneBoot?: boolean } = {},
): void {
  const last = kills.at(-1);
  if (last === undefined) throw new Error('no kill to judge');
  const results = rig.evaluate({ census: last.census, report, boots: report.recovered.length });
  for (const kill of kills.slice(0, -1)) results.push(checkI3(kill.census));
  assertInvariants(results);
  if (options.atLeastOneBoot !== false && report.recovered.length < 1) {
    throw new Error('the last start did not write daemon.recovered');
  }
}
