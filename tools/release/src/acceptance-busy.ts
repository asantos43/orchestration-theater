// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  apiOf,
  checkUpdate,
  closeRun,
  eventsOf,
  installBy,
  openRun,
  publish,
  runSteps,
  sleep,
  startDaemon,
  statusOf,
  stopDaemon,
  until,
  versionOf,
  writeConfig,
  type AcceptanceOptions,
  type AcceptanceStep,
  type Api,
  type Run,
  type StepBody,
} from './acceptance.js';

/**
 * The update with a piece in progress (Phase 10, N303 (2); docs/21, P12 "Como ficou"): level
 * `phase10-busy` of `tools/acceptance/real-acceptance.sh`. [proposta] It is the other half of
 * `acceptance.ts`, which runs `idle` and `park` with the daemon quiet because the fake agent cannot
 * take the place of a profile in a built executable. Here the profile is the one of a logged-in
 * client, only pointed at, and the piece is a real one.
 *
 * What a run does, once for `idle` and once for `park` (each in its own temporary HOME, data folder
 * and release server on the loopback, signed by a key made for the run):
 * 1. installs N with `install.sh` and writes the `config.yaml` (the Executor `claude-code/real`, the
 *    sandbox off, no adapter installed, no code host) and a link `<data>/profiles/claude-code/real`
 *    to the profile that is already logged in. Nothing is copied or read: the daemon and the client
 *    open it. No hook of test is in the executable, and no profile row or vault entry is needed;
 * 2. starts the daemon of N as a child, makes a project (a git repository with a bare `origin`) and
 *    opens a scenario;
 * 3. sends a small need to the Director through the chat socket and answers what it asks (the first
 *    option of a question; a menu is a failure), until an attempt is `executing` with a session;
 * 4. WHILE that attempt runs, publishes N+1 and asks the daemon to look for it;
 * 5. `idle`: the apply step waits (state `waiting`), the attempt ends, and only then the swap
 *    starts (`applying` comes after `attempt.submitted` in the log). `park`: the swap starts at
 *    once, the clean stop of the daemon leaves the attempt `awaiting_resume`, and the daemon of N+1
 *    goes on (`session.interrupted` with the cause `daemon_restart`, then `session.resumed`, with
 *    `native` meaning `session/load`, or the demand run again as a later attempt: see `judgePark`);
 * 6. the journal says `committed`, the events `applying` and `applied` are there, the executable
 *    says N+1 and the play ends in DONE with `delivery.completed`: the piece was not lost;
 * 7. stops the daemon and looks for a process of the run that is still alive (by cwd and command
 *    line, in the folder of the run).
 *
 * Nothing here runs a client by itself: the daemon does, from the executable that was installed.
 * [N] Not run with a real client when written. Not proven: that a link inside `<data>` is read by
 * the client with the sandbox off (the measure of 2026-11-20 in `paths.ts` was with it on). The
 * daemon of the release does not restore a session by `session/load` today (see `judgePark`).
 */

export const BUSY_MODES = ['idle', 'park'] as const;
export type BusyMode = (typeof BUSY_MODES)[number];

/**
 * `native` (the default) asks for the `session/load`, what the daemon does with
 * `resume.on_restart: native`; `any` also takes the handoff to a new session and the demand run
 * again as a later attempt (what it does with `resume.on_restart: handoff`).
 */
export const BUSY_RESUME_FORMS = ['native', 'any'] as const;
export type BusyResumeForm = (typeof BUSY_RESUME_FORMS)[number];

export interface BusyOptions extends AcceptanceOptions {
  readonly modes: readonly BusyMode[];
  /**
   * The profile that is already logged in, linked (never copied or read) as
   * `<data>/profiles/claude-code/real`. Absent: no link (a run with a fake ACP command).
   */
  readonly profileDir?: string | undefined;
  readonly model: string;
  /** `clients.claude-code` mode of the session, when the profile needs one. */
  readonly clientMode?: string | undefined;
  /**
   * An ACP command in place of `claude-agent-acp` from the `PATH` (`clients.claude-code.command`).
   * Absent: the adapter of the `PATH` (`clients.claude-code.adapter: path`).
   */
  readonly clientCommand?: string | undefined;
  /** The `PATH` of the daemon (and so of the client). Default: the one of this process. */
  readonly daemonPath?: string | undefined;
  /** The need handed to the Director. */
  readonly need: string;
  /** The longest the piece may take, from the first message to the end of the play. */
  readonly playTimeoutMs: number;
  /** `updates.max_wait` of the `idle` run: past it the daemon asks instead of waiting. */
  readonly maxWait: string;
  /** `limits.preset`. */
  readonly limitsPreset: string;
  readonly resumeForm: BusyResumeForm;
  /** Put at the start of every log line. */
  readonly prefix?: string | undefined;
}

export interface BusyResult {
  readonly ok: boolean;
  readonly steps: readonly AcceptanceStep[];
}

const ANSWER_FALLBACK = 'Use your best judgment and keep it as small as possible.';
const NO_PLAY_GRACE_MS = 90_000;
const TERMINAL_PLAY_STATES = ['DONE', 'CANCELLED', 'FAILED'];

/** A failure that ends a wait at once (`until` of the acceptance turns every error into "not yet"). */
class Fatal extends Error {}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  read: () => Promise<T | undefined> | T | undefined,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = await read();
    } catch (error) {
      if (error instanceof Fatal) throw new Error(error.message, { cause: error });
    }
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await sleep(everyMs);
  }
}

// ---- pure pieces (unit tests) -------------------------------------------------------------------

/** The sections of `config.yaml` that make the daemon of the run work with a client. */
export function busyConfigExtra(
  options: Pick<
    BusyOptions,
    'model' | 'clientMode' | 'clientCommand' | 'limitsPreset' | 'profileDir'
  >,
): string {
  const client =
    options.clientCommand === undefined
      ? '    adapter: path\n'
      : `    command: { cmd: ${JSON.stringify(options.clientCommand)}, args: [] }\n`;
  return [
    'security:',
    '  unenforced: warn',
    'limits:',
    `  preset: ${options.limitsPreset}`,
    'clients:',
    '  adapters:',
    "    install: 'off'",
    '  claude-code:',
    // The quota statusline is written into the settings of the profile; the profile here is the
    // owner's own, so the run leaves it as it is.
    client + "    quota_statusline: 'off'",
    'orchestration:',
    '  executor:',
    '    client: claude-code',
    '    profile: real',
    `    model: ${JSON.stringify(options.model)}`,
    ...(options.clientMode === undefined || options.clientMode === ''
      ? []
      : [`    mode: ${JSON.stringify(options.clientMode)}`]),
    '',
  ].join('\n');
}

/** What the Producer answers to a question of the Director: the first option, else a fallback. */
export function answersOf(input: unknown): string[] {
  const questions = (input as { questions?: { options?: { label?: unknown }[] }[] } | null)
    ?.questions;
  return (questions ?? []).map((question) => {
    const first = question.options?.[0]?.label;
    return typeof first === 'string' && first !== '' ? first : ANSWER_FALLBACK;
  });
}

export interface LoggedEvent {
  readonly id?: number;
  readonly type?: string;
  readonly attemptId?: string;
  readonly playId?: string;
  readonly payload?: Record<string, unknown>;
}

const attemptOf = (event: LoggedEvent): string | undefined =>
  event.attemptId ?? (event.payload?.attemptId as string | undefined);

/**
 * `idle`: the swap began after the attempt ended. The event `daemon.update` with phase `applying`
 * comes after `attempt.submitted` of the attempt in the log (a later id). Returns a text on success.
 */
export function judgeIdle(events: readonly LoggedEvent[], attemptId: string): string {
  const submitted = events.find(
    (event) => event.type === 'attempt.submitted' && attemptOf(event) === attemptId,
  );
  const applying = events.find(
    (event) => event.type === 'daemon.update' && event.payload?.phase === 'applying',
  );
  if (submitted?.id === undefined) throw new Error(`no attempt.submitted for ${attemptId}`);
  if (applying?.id === undefined) throw new Error('no daemon.update "applying" event');
  if (applying.id < submitted.id) {
    throw new Error(
      `the swap began (event ${String(applying.id)}) before the attempt ended (event ${String(submitted.id)})`,
    );
  }
  return `attempt.submitted (event ${String(submitted.id)}) came before "applying" (event ${String(applying.id)})`;
}

/** Whether `other` is a later attempt of the demand of `attemptId` (`<play>/<demand>/<n>`). */
function sameDemandLater(attemptId: string, other: string | undefined): boolean {
  if (other === undefined) return false;
  const cut = attemptId.lastIndexOf('/');
  const otherCut = other.lastIndexOf('/');
  if (cut < 0 || otherCut < 0 || attemptId.slice(0, cut) !== other.slice(0, otherCut)) return false;
  return Number(other.slice(otherCut + 1)) > Number(attemptId.slice(cut + 1));
}

/**
 * `park`: the attempt was interrupted by the restart of the daemon and the piece went on. Needs
 * `session.interrupted` with the cause `daemon_restart` for the attempt, then one of:
 * - `session.resumed` for it, with `form: native` (a `session/load`) or `handoff`;
 * - a `session.opened` of a later attempt of the same demand (the play ran it again).
 * With `resumeForm: native` only the first, native one counts. Before `resume.on_restart`, the
 * daemon parked every attempt for the handoff and the play ran the stage again [V: the fake agent
 * in the SEA, 2026-11-24]: the form seen then was the third.
 */
export function judgePark(
  events: readonly LoggedEvent[],
  attemptId: string,
  resumeForm: BusyResumeForm,
): string {
  const interrupted = events.find(
    (event) =>
      event.type === 'session.interrupted' &&
      attemptOf(event) === attemptId &&
      event.payload?.cause === 'daemon_restart',
  );
  if (interrupted === undefined) {
    throw new Error(`no session.interrupted with cause daemon_restart for ${attemptId}`);
  }
  const after = (event: LoggedEvent): boolean => (event.id ?? 0) > (interrupted.id ?? 0);
  const resumed = events.find(
    (event) => event.type === 'session.resumed' && attemptOf(event) === attemptId && after(event),
  );
  if (resumed !== undefined) {
    const form = String(resumed.payload?.form);
    if (resumeForm === 'native' && form !== 'native') {
      throw new Error(`the session came back as "${form}", not by session/load (native)`);
    }
    return `interrupted (daemon_restart), then resumed as "${form}"`;
  }
  const again = events.find(
    (event) =>
      event.type === 'session.opened' &&
      after(event) &&
      sameDemandLater(attemptId, attemptOf(event)),
  );
  if (again === undefined) throw new Error(`no session.resumed for ${attemptId} after the stop`);
  if (resumeForm === 'native') {
    throw new Error(
      `no session/load: the demand ran again as ${attemptOf(again) ?? '?'} (a new session), not a native resume`,
    );
  }
  return `interrupted (daemon_restart), then the demand ran again as ${attemptOf(again) ?? '?'} (no session/load)`;
}

/** The processes (other than this one) whose working directory or command line is inside `root`. */
export function leftoverProcesses(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { pid: number; command: string }[] {
  const found: { pid: number; command: string }[] = [];
  const inside = (value: string): boolean =>
    value === root || value.startsWith(`${root}${path.sep}`);
  if (platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim();
        let cwd = '';
        try {
          cwd = readlinkSync(`/proc/${name}/cwd`);
        } catch {
          // Not ours to read: it is not a process of the run.
        }
        if (inside(cwd) || command.includes(root))
          found.push({ pid, command: command.slice(0, 200) });
      } catch {
        // Gone while the folder was read.
      }
    }
    return found;
  }
  const listed = spawnSync('ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (pid !== process.pid && command.includes(root))
      found.push({ pid, command: command.slice(0, 200) });
  }
  return found;
}

// ---- the project and the piece ------------------------------------------------------------------

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const ended = spawnSync(
    'git',
    ['-c', 'user.name=otheater-acceptance', '-c', 'user.email=acceptance@example.invalid', ...args],
    { cwd, env, encoding: 'utf8', timeout: 60_000 },
  );
  if (ended.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${String(ended.status)}: ${ended.stderr.slice(-300)}`,
    );
  }
}

/** A git repository with a bare `origin` and one commit, inside the folder of the run. */
function makeProject(r: Run): string {
  const base = path.join(r.root, 'project');
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  mkdirSync(repo, { recursive: true });
  const env = { PATH: r.env.PATH, HOME: r.home, LANG: 'C.UTF-8' };
  git(base, env, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(repo, env, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(repo, 'README.md'), '# acceptance project\n');
  git(repo, env, 'add', 'README.md');
  git(repo, env, 'commit', '--quiet', '-m', 'initial commit');
  git(repo, env, 'remote', 'add', 'origin', remote);
  git(repo, env, 'push', '--quiet', 'origin', 'main');
  return realpathSync(repo);
}

interface Page<T> {
  items: T[];
}

interface Attempt {
  attemptId: string;
  state: string;
  sessionId: string | null;
  cause: string | null;
}

interface Piece {
  scenarioId: string;
  playId: string | undefined;
  attemptId: string | undefined;
  /** Decisions already answered, and the failures the answerer found. */
  answered: Set<string>;
  problems: string[];
  stop: boolean;
  /** The Director spoke (a final reply) at least once. */
  replies: number;
  chat: WebSocket | undefined;
}

async function getJson<T>(api: Api, route: string): Promise<T | undefined> {
  try {
    return (await api.get(route)) as T;
  } catch {
    return undefined;
  }
}

/** Opens the chat socket with a ticket, sends the need and keeps counting the replies. */
async function sendNeed(r: Run, piece: Piece, need: string): Promise<void> {
  const api = apiOf(r.data);
  const ticket = await api.send('POST', '/v1/chat-tickets', { scenarioId: piece.scenarioId });
  const text = (ticket.body as { ticket?: string } | undefined)?.ticket;
  if (ticket.status !== 200 || text === undefined)
    throw new Error(`POST /v1/chat-tickets answered ${String(ticket.status)}`);
  const base = readDiscoveryUrl(r).replace(/^http/, 'ws');
  const socket = new WebSocket(
    `${base}/v1/scenarios/${encodeURIComponent(piece.scenarioId)}/chat?ticket=${encodeURIComponent(text)}`,
  );
  piece.chat = socket;
  socket.addEventListener('message', (message) => {
    try {
      const frame = JSON.parse(String(message.data)) as { type?: string; final?: boolean };
      if (frame.type === 'director_reply' && frame.final === true) piece.replies += 1;
    } catch {
      // A frame that is not JSON is not one of ours.
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the chat socket did not open in 60 s'));
    }, 60_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the chat socket failed to open'));
    });
  });
  socket.send(JSON.stringify({ type: 'message', text: need }));
}

function readDiscoveryUrl(r: Run): string {
  const info = JSON.parse(readFileSync(path.join(r.data, 'api.json'), 'utf8')) as { url: string };
  return info.url;
}

/**
 * Answers the decisions of the scenario while the piece runs, by REST (it goes on through the swap:
 * a call that fails while the daemon is changing is tried again in two seconds). A question gets its
 * first option; anything else is a limit that ran out, a failure of the run, so the play is cancelled.
 */
function startAnswerer(r: Run, piece: Piece): Promise<void> {
  return (async () => {
    while (!piece.stop) {
      try {
        const api = apiOf(r.data);
        const page = await getJson<Page<{ id: string; kind: string; input: unknown }>>(
          api,
          `/v1/scenarios/${encodeURIComponent(piece.scenarioId)}/decisions?state=pending`,
        );
        for (const decision of page?.items ?? []) {
          if (piece.answered.has(decision.id)) continue;
          piece.answered.add(decision.id);
          const answer =
            decision.kind === 'producer_question'
              ? { answers: answersOf(decision.input) }
              : { option: 'cancel', reason: 'the real test gave up' };
          if (decision.kind !== 'producer_question')
            piece.problems.push(`the play asked for a decision of kind ${decision.kind}`);
          await api.send('POST', `/v1/decisions/${encodeURIComponent(decision.id)}/answer`, {
            answer,
          });
        }
      } catch {
        // The daemon is changing, or the call failed: next round.
      }
      await sleep(2000);
    }
  })();
}

async function playOf(r: Run, piece: Piece): Promise<{ id: string; state: string } | undefined> {
  const page = await getJson<Page<{ id: string; state: string }>>(
    apiOf(r.data),
    `/v1/scenarios/${encodeURIComponent(piece.scenarioId)}/plays`,
  );
  const items = page?.items ?? [];
  return items[items.length - 1];
}

async function openAttempt(r: Run, playId: string): Promise<Attempt | undefined> {
  const page = await getJson<Page<Attempt>>(
    apiOf(r.data),
    `/v1/plays/${encodeURIComponent(playId)}/attempts?open=true`,
  );
  return page?.items.find((attempt) => attempt.state === 'executing' && attempt.sessionId !== null);
}

const WANTED_EVENTS = [
  'attempt.submitted',
  'session.opened',
  'session.interrupted',
  'session.resumed',
  'play.created',
  'play.transitioned',
  'delivery.completed',
  'daemon.update',
];

async function loggedEvents(r: Run): Promise<LoggedEvent[]> {
  return await apiOf(r.data).events(WANTED_EVENTS);
}

interface UpdateApply {
  apply: { state: string };
}

// ---- the run of one mode ------------------------------------------------------------------------

function stepsOf(
  options: BusyOptions,
  mode: BusyMode,
  log: (line: string) => void,
): { steps: [string, StepBody][]; stop: () => void } {
  const { versionN, versionN1, exeN, exeN1 } = options;
  const piece: Piece = {
    scenarioId: '',
    playId: undefined,
    attemptId: undefined,
    answered: new Set(),
    problems: [],
    stop: false,
    replies: 0,
    chat: undefined,
  };
  let answerer: Promise<void> | undefined;
  let pidN = 0;
  let waited = false;

  const steps: [string, StepBody][] = [
    [
      `${mode}: install ${versionN}`,
      async (r) => {
        await publish(r, { version: versionN, exe: exeN });
        const how = await installBy(r, versionN);
        const says = await versionOf(r.installed, r.env);
        if (!says.includes(versionN)) throw new Error(`the installed executable says "${says}"`);
        return `${how}; says ${says}`;
      },
    ],
    [
      `${mode}: config, the link to the profile and the project`,
      (r) => {
        if (options.daemonPath !== undefined) r.env.PATH = options.daemonPath;
        writeConfig(r, {
          apply_when: mode,
          max_wait: mode === 'idle' ? options.maxWait : '1m',
          code_host: 'none',
          extra: busyConfigExtra(options),
        });
        let linked = 'no profile linked (a command of test)';
        if (options.profileDir !== undefined) {
          const source = realpathSync(options.profileDir);
          const folder = path.join(r.data, 'profiles', 'claude-code');
          mkdirSync(folder, { recursive: true });
          symlinkSync(source, path.join(folder, 'real'), 'dir');
          linked =
            'profiles/claude-code/real is a link to the profile that is logged in (not read)';
        }
        const repo = makeProject(r);
        return Promise.resolve(
          `${linked}; project ${path.basename(path.dirname(repo))}/${path.basename(repo)} with a bare origin`,
        );
      },
    ],
    [
      `${mode}: daemon ${versionN} up, scenario open`,
      async (r) => {
        pidN = await startDaemon(r);
        const repo = path.join(r.root, 'project', 'repo');
        const opened = await apiOf(r.data).send('POST', '/v1/scenarios', {
          repo: realpathSync(repo),
        });
        const id = (opened.body as { scenario?: { id?: string } } | undefined)?.scenario?.id;
        if (opened.status !== 200 || id === undefined)
          throw new Error(`POST /v1/scenarios answered ${String(opened.status)}`);
        piece.scenarioId = id;
        return `pid ${String(pidN)}; scenario ${id}`;
      },
    ],
    [
      `${mode}: a real piece starts and an attempt is executing`,
      async (r) => {
        answerer = startAnswerer(r, piece);
        await sendNeed(r, piece, options.need);
        const started = Date.now();
        let quiet: number | undefined;
        const attempt = await waitFor(
          'an attempt executing with a session',
          options.playTimeoutMs,
          async () => {
            if (piece.problems.length > 0) throw new Fatal(piece.problems.join('; '));
            const play = await playOf(r, piece);
            if (play === undefined) {
              if (piece.replies > 0) {
                quiet ??= Date.now();
                if (Date.now() - quiet >= NO_PLAY_GRACE_MS)
                  throw new Fatal('the Director answered without opening a play');
              }
              return undefined;
            }
            piece.playId = play.id;
            if (TERMINAL_PLAY_STATES.includes(play.state))
              throw new Fatal(
                `the play ended (${play.state}) before an attempt could be caught: the need is too small`,
              );
            return await openAttempt(r, play.id);
          },
          2000,
        );
        piece.attemptId = attempt.attemptId;
        piece.chat?.close();
        return `play ${String(piece.playId)}, attempt ${attempt.attemptId} executing (session open) after ${String(Math.round((Date.now() - started) / 1000))} s`;
      },
    ],
    [
      `${mode}: ${versionN1} is published while the attempt runs`,
      async (r) => {
        const playId = piece.playId;
        const attemptId = piece.attemptId;
        if (playId === undefined || attemptId === undefined) throw new Error('no attempt');
        await publish(r, { version: versionN1, exe: exeN1 });
        // The attempt must still be running when the daemon is asked: the level is about that.
        const still = await openAttempt(r, playId);
        if (still?.attemptId !== attemptId)
          throw new Error(
            'the attempt ended before the update was asked for: the need is too small (nothing was tested)',
          );
        await checkUpdate(r);
        if (mode === 'idle') {
          const seen = await waitFor(
            'the apply step to wait for the attempt',
            60_000,
            async () => {
              const status = await getJson<UpdateApply>(apiOf(r.data), '/v1/updates');
              if (status?.apply.state === 'asked')
                throw new Fatal(
                  'updates.max_wait ended and the daemon asked: raise OT_TEST_BUSY_MAX_WAIT',
                );
              if (status?.apply.state === 'applying' || (await statusOf(r))?.version === versionN1)
                throw new Fatal(`the swap started with the attempt still ${still.state}`);
              return status?.apply.state === 'waiting' ? status : undefined;
            },
            500,
          );
          waited = true;
          return `apply state "${seen.apply.state}" with attempt ${attemptId} executing: the swap waits`;
        }
        return `asked with apply_when park: the swap goes on at once, attempt ${attemptId} is parked by the stop`;
      },
    ],
    [
      `${mode}: the swap, the journal and the events`,
      async (r) => {
        // The applier replaces the executable and starts the daemon of N+1; the old one ends by itself.
        const now = await until(
          `the daemon at version ${versionN1}`,
          options.playTimeoutMs,
          async () => {
            const status = await statusOf(r);
            return status?.version === versionN1 && status.pid !== pidN ? status : undefined;
          },
          1000,
        );
        const journal = await until(
          'the journal to say committed',
          180_000,
          () => {
            const state = JSON.parse(
              readFileSync(path.join(path.dirname(r.installed), 'update-state.json'), 'utf8'),
            ) as { step: string; from: string; to: string };
            return state.step === 'committed' ? state : undefined;
          },
          1000,
        );
        if (journal.from !== versionN || journal.to !== versionN1)
          throw new Error(`the journal says ${JSON.stringify(journal)}`);
        const phases = (await eventsOf(r)).map((event) => event.phase);
        for (const phase of ['found', 'downloaded', 'verified', 'applying', 'applied']) {
          if (!phases.includes(phase))
            throw new Error(`no daemon.update "${phase}" event (got ${phases.join(', ')})`);
        }
        const says = await versionOf(r.installed, r.env);
        if (!says.includes(versionN1)) throw new Error(`the installed executable says "${says}"`);
        const attemptId = piece.attemptId;
        if (attemptId === undefined) throw new Error('no attempt');
        const events = await loggedEvents(r);
        const verdict =
          mode === 'idle'
            ? judgeIdle(events, attemptId)
            : judgePark(events, attemptId, options.resumeForm);
        return `${versionN} -> ${versionN1}, journal committed, pid ${String(pidN)} -> ${String(now.pid)}; ${verdict}${waited ? '; it waited' : ''}`;
      },
    ],
    [
      `${mode}: the piece is not lost`,
      async (r) => {
        const playId = piece.playId;
        if (playId === undefined) throw new Error('no play');
        const play = await waitFor(
          'the play to end',
          options.playTimeoutMs,
          async () => {
            if (piece.problems.length > 0) throw new Fatal(piece.problems.join('; '));
            const current = await playOf(r, piece);
            return current !== undefined && TERMINAL_PLAY_STATES.includes(current.state)
              ? current
              : undefined;
          },
          2000,
        );
        if (play.state !== 'DONE') throw new Error(`the play ended in ${play.state}, not DONE`);
        const events = await loggedEvents(r);
        const delivered = events.filter(
          (event) => event.type === 'delivery.completed' && event.playId === playId,
        );
        if (delivered.length === 0) throw new Error('no delivery.completed for the play');
        piece.stop = true;
        await answerer;
        return `play ${playId} DONE after the swap, delivery.completed x${String(delivered.length)}`;
      },
    ],
    [
      `${mode}: nothing is left running`,
      async (r) => {
        piece.stop = true;
        piece.chat?.close();
        await stopDaemon(r);
        const left = await until(
          'the processes of the run to end',
          20_000,
          () => {
            const alive = leftoverProcesses(r.root, r.platform);
            return alive.length === 0 ? [] : undefined;
          },
          1000,
        ).catch(() => leftoverProcesses(r.root, r.platform));
        if (left.length > 0) {
          throw new Error(
            `${String(left.length)} process(es) left: ${left.map((p) => `${String(p.pid)} ${p.command}`).join(' | ')}`,
          );
        }
        log('  no process of the run is alive');
        return 'no process whose folder or command line is in the folder of the run';
      },
    ],
  ];
  return {
    steps,
    stop: () => {
      piece.stop = true;
      piece.chat?.close();
    },
  };
}

/** The update with a piece in progress, in each of `options.modes`. */
export async function runBusyAcceptance(options: BusyOptions): Promise<BusyResult> {
  const prefix = options.prefix === undefined ? '' : `${options.prefix} `;
  const log = (line: string): void => {
    options.log(`${prefix}${line}`);
  };
  const all: AcceptanceStep[] = [];
  for (const mode of options.modes) {
    const r = await openRun({ ...options, log });
    log(`apply_when ${mode}: ${options.versionN} -> ${options.versionN1}; sandbox ${r.root}`);
    const { steps, stop } = stepsOf(options, mode, log);
    // An abort (Ctrl+C, the timeout of the script) stops the daemon of the run before it leaves:
    // a daemon left behind would hold the folder, the port and the client of the piece.
    const onSignal = (signal: NodeJS.Signals): void => {
      log(`  ${signal}: stopping the daemon of the run`);
      stop();
      void closeRun(r).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      all.push(...(await runSteps(r, steps, log)));
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      stop();
      await closeRun(r);
    }
  }
  return { ok: all.length > 0 && all.every((step) => step.ok), steps: all };
}
