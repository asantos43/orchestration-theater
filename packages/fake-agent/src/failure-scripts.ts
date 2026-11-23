// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { QUOTA_EXHAUSTED_CODE } from '@otheater/protocol';
import { z } from 'zod';

/**
 * [proposal] The failure scripts (Phase 11, P2): an Executor that dies, goes mute, ignores
 * `SIGTERM`, leaves a grandchild behind, is slow, or answers with the error of a login that
 * expired, of a quota that ran out and of a provider that is down. They are what the chaos tests
 * of the daemon (P3, P4, P7) play the failure with; nothing here touches the network or the
 * `PATH`.
 *
 * Hygiene: every process these scripts leave alive ends itself (the grandchild after `lifeMs`, a
 * stalled agent after `lifeMs` too), so a test that fails before its cleanup never leaves an
 * orphan for good. A test still ends them by pid; the timers are the safety net, not the plan.
 */

/** The longest any process of these scripts lives on its own, in ms. */
export const MAX_LIFE_MS = 60_000;

const lifeMs = (fallback: number) => z.int().min(100).max(MAX_LIFE_MS).default(fallback);

/**
 * The process kills itself with `SIGKILL`: no `close`, no `exit` event, no answer. After
 * `afterChunks` message chunks (`die chunk 1`, ...), or when the turn opens (`afterChunks: 0`).
 * `at: 'open'` is for `FAKE_AGENT_SCRIPT` (the default script): the process dies when it starts,
 * before it reads the first request, as a client that cannot even open does. In a `#script:`
 * directive it means the same as `afterChunks: 0`.
 */
export const dieScriptSchema = z.strictObject({
  name: z.literal('die'),
  afterChunks: z.int().min(0).max(1000).default(0),
  at: z.enum(['turn', 'open']).default('turn'),
});

/**
 * Alive and mute: after `chunks` message chunks nothing more is sent, `session/cancel` is not
 * answered and the stdout stays open. The process ends itself `lifeMs` after the turn started.
 */
export const stallScriptSchema = z.strictObject({
  name: z.literal('stall'),
  chunks: z.int().min(0).max(1000).default(0),
  lifeMs: lifeMs(MAX_LIFE_MS),
});

/**
 * Ignores the polite signals (`SIGTERM` by default) and then stalls like {@link stallScriptSchema}:
 * only `SIGKILL` ends it. As a default script (`FAKE_AGENT_SCRIPT`) the signals are ignored from
 * the start of the process, not only from the first turn.
 */
export const ignoreTermScriptSchema = z.strictObject({
  name: z.literal('ignore-term'),
  signals: z
    .array(z.enum(['SIGTERM', 'SIGINT', 'SIGHUP']))
    .min(1)
    .default(['SIGTERM']),
  lifeMs: lifeMs(MAX_LIFE_MS),
});

/**
 * Starts a grandchild (a tool of the turn that outlives the agent), writes its pid to
 * `$FAKE_AGENT_STATE_DIR/<file>` and says it in a chunk (`grandchild pid <n>`). The grandchild runs
 * in the working directory of the session and ends itself after `lifeMs` (at most 60 s).
 * `detached` puts it in a group of its own, out of reach of a kill of the group of the agent. Then
 * the turn does `after`: ends (`end_turn`), stalls, or kills the agent with `SIGKILL` (`die`), so the
 * grandchild is left without a parent.
 */
export const spawnChildScriptSchema = z.strictObject({
  name: z.literal('spawn-child'),
  file: z.string().min(1).default('grandchild.pid'),
  lifeMs: lifeMs(30_000),
  detached: z.boolean().default(false),
  after: z.enum(['end_turn', 'stall', 'die']).default('end_turn'),
});

/** `chunks` message chunks, `intervalMs` apart (`slow 1/5`, ...). A cancel ends it at once. */
export const slowScriptSchema = z.strictObject({
  name: z.literal('slow'),
  chunks: z.int().min(1).max(1000).default(5),
  intervalMs: z.int().min(0).max(MAX_LIFE_MS).default(100),
});

/** The login of the profile expired: the error the three clients normalize to `auth_required`. */
export const failAuthScriptSchema = z.strictObject({
  name: z.literal('fail-auth'),
  message: z.string().min(1).default('Authentication required: please run /login'),
});

/**
 * The quota ran out, with no `quota` signal before it (that is `quota-signal`). `resetsAt` is an
 * ISO instant; it travels in the data and, as epoch seconds after a pipe, in the default message.
 */
export const failQuotaScriptSchema = z.strictObject({
  name: z.literal('fail-quota'),
  resetsAt: z.string().optional(),
  message: z.string().min(1).optional(),
});

/** The provider is overloaded or down: the error the three clients normalize to `transient`. */
export const failTransientScriptSchema = z.strictObject({
  name: z.literal('fail-transient'),
  message: z.string().min(1).default('Overloaded: API Error 529 overloaded_error'),
});

export type DieScript = z.infer<typeof dieScriptSchema>;
export type StallScript = z.infer<typeof stallScriptSchema>;
export type IgnoreTermScript = z.infer<typeof ignoreTermScriptSchema>;
export type SpawnChildScript = z.infer<typeof spawnChildScriptSchema>;
export type SlowScript = z.infer<typeof slowScriptSchema>;
export type FailAuthScript = z.infer<typeof failAuthScriptSchema>;
export type FailQuotaScript = z.infer<typeof failQuotaScriptSchema>;
export type FailTransientScript = z.infer<typeof failTransientScriptSchema>;

/** JSON-RPC code of "authentication required" in the three ACP adapters. [S] (see `normalize-*`) */
export const AUTH_REQUIRED_CODE = -32000;
/** JSON-RPC code `fail` and the adapters use for an internal error. */
export const INTERNAL_ERROR_CODE = -32603;

/**
 * The error of `fail-auth`. One shape that each client adapter reads as `auth_required`:
 * Claude Code by the code `-32000` and by the text (`Authentication required`, `/login`), Codex by
 * `data.codexErrorInfo: 'unauthorized'`, OpenCode by the code `-32000`.
 */
export function authError(script: FailAuthScript): RequestError {
  return new RequestError(AUTH_REQUIRED_CODE, script.message, {
    script: 'fail-auth',
    codexErrorInfo: 'unauthorized',
  });
}

/**
 * The error of `fail-quota`: code `-32001` and `data.type: 'QuotaExhausted'` (OpenCode and the
 * fake adapter), `usage limit reached` in the message (Claude Code) and
 * `data.codexErrorInfo: 'usageLimitExceeded'` (Codex). The `data` carries one field more than
 * `quotaExhaustedDataSchema` (`codexErrorInfo`), so the strict parse of the daemon in
 * `limitHitOf` misses the reset time of a raw error; a typed error of an adapter carries it in the
 * normalized `cause`.
 */
export function quotaError(script: FailQuotaScript): RequestError {
  const epochSeconds =
    script.resetsAt === undefined ? Number.NaN : Math.floor(Date.parse(script.resetsAt) / 1000);
  const message =
    script.message ??
    (Number.isNaN(epochSeconds)
      ? 'Claude AI usage limit reached'
      : `Claude AI usage limit reached|${String(epochSeconds)}`);
  return new RequestError(QUOTA_EXHAUSTED_CODE, message, {
    type: 'QuotaExhausted',
    codexErrorInfo: 'usageLimitExceeded',
    ...(script.resetsAt === undefined ? {} : { resetsAt: script.resetsAt }),
  });
}

/**
 * The error of `fail-transient`: `-32603` with an overload message (Claude Code and OpenCode match
 * `overloaded` and the `529`) and `data.codexErrorInfo: 'serverOverloaded'` (Codex).
 */
export function transientError(script: FailTransientScript): RequestError {
  return new RequestError(INTERNAL_ERROR_CODE, script.message, {
    script: 'fail-transient',
    codexErrorInfo: 'serverOverloaded',
  });
}

/** Resolves once what was written to the stdout before is out of the process. */
export function flushStdout(): Promise<void> {
  return new Promise((done) => {
    process.stdout.write('', () => {
      done();
    });
  });
}

/** `SIGKILL` on itself. Never returns in practice. */
export function killSelf(): Promise<never> {
  process.kill(process.pid, 'SIGKILL');
  // The signal is delivered when the process next runs: nothing after this line may happen.
  return new Promise<never>(() => undefined);
}

/** Dies after the bytes already written are out, so the peer sees every chunk that was sent. */
export async function dieAfterFlush(): Promise<never> {
  await flushStdout();
  return killSelf();
}

/**
 * Keeps the process alive, mute, for at most `lifeMs`; then `SIGKILL`. The timer holds the event
 * loop open even after the stdin closed. Never resolves.
 */
export function stallForever(lifeMs: number): Promise<never> {
  setTimeout(() => {
    process.kill(process.pid, 'SIGKILL');
  }, lifeMs);
  return new Promise<never>(() => undefined);
}

/** Installs a handler that swallows each signal (the process then ends only with `SIGKILL`). */
export function ignoreSignals(signals: readonly NodeJS.Signals[]): void {
  for (const signal of signals) {
    process.on(signal, () => undefined);
  }
}

/**
 * What a default script (`FAKE_AGENT_SCRIPT`) does before the agent serves anything: `die` with
 * `at: 'open'` kills the process, `ignore-term` arms its signals from the start. Called by the
 * binary only; the library never does it by itself.
 */
export async function armAtStartup(script: {
  readonly name: string;
  readonly at?: string;
  readonly signals?: readonly NodeJS.Signals[];
}): Promise<void> {
  if (script.name === 'die' && script.at === 'open') {
    await killSelf();
  } else if (script.name === 'ignore-term' && script.signals !== undefined) {
    ignoreSignals(script.signals);
  }
}

/** Waits `ms`, or until `signal` aborts. Tells whether the whole time passed. */
export function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal.aborted) {
      done(false);
      return;
    }
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      done(completed);
    };
    const onAbort = (): void => {
      finish(false);
    };
    const timer = setTimeout(() => {
      finish(true);
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * Starts the grandchild of `spawn-child`: a Node process that only waits `lifeMs` and exits, in
 * `cwd`, with no stdio, outside the event loop of the agent (`unref`). Writes its pid to
 * `<stateDir>/<file>` and returns it.
 */
export async function startGrandchild(options: {
  readonly script: SpawnChildScript;
  readonly cwd: string;
  readonly stateDir: string;
}): Promise<number> {
  const { script, cwd, stateDir } = options;
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${String(script.lifeMs)})`], {
    cwd,
    stdio: 'ignore',
    detached: script.detached,
  });
  child.unref();
  const { pid } = child;
  if (pid === undefined) throw new Error('the grandchild did not start');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, script.file), `${String(pid)}\n`);
  return pid;
}
