// SPDX-License-Identifier: MPL-2.0
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * What to measure: whether ONE client process accepts `sessions` calls to `session/new`. For the
 * real tests behind `OT_TEST_REAL_CLIENTS` (N57); nothing here sends a prompt. The caller builds
 * the environment (and so decides which account the process sees); this file reads none.
 */
export interface SessionsPerProcessProbe {
  readonly cmd: string;
  readonly args?: readonly string[];
  /** Working directory of the process, and the `cwd` of every session. */
  readonly cwd: string;
  /** The WHOLE environment of the process: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** How many `session/new` calls to make on the one process. */
  readonly sessions: number;
  /** Extra fields of `session/new` (for example the `_meta` a client takes). */
  readonly newParams?: (cwd: string, index: number) => Record<string, unknown>;
  /** Limit for each ACP call. Default 30 000 ms. */
  readonly timeoutMs?: number;
}

/** What the client did. `accepted === requested` means the client takes that many sessions in one process. */
export interface SessionsPerProcessReport {
  readonly requested: number;
  readonly accepted: number;
  readonly distinctSessionIds: number;
  /** One short line per refused `session/new` (the JSON-RPC error, cut to 200 characters). */
  readonly failures: readonly string[];
  /** Ids of the config options the first accepted session announced (names only, no values). */
  readonly configOptionIds: readonly string[];
  /** Resident memory of the process after the last `session/new`, in KiB; `undefined` off Linux. */
  readonly rssKiB: number | undefined;
  /** The process was still alive after the last call. */
  readonly processAlive: boolean;
  /**
   * `agentInfo` of the `initialize` answer (N63): what the client says about itself. `undefined`
   * when it sent none (it is optional in ACP) or when name and version are not strings.
   */
  readonly agentInfo: { readonly name: string; readonly version: string } | undefined;
}

type Json = Record<string, unknown>;

/**
 * Starts the command, runs `initialize`, makes `sessions` calls to `session/new` one after the
 * other on the same process and reports what the client answered. The process (its whole tree)
 * is killed by pid at the end: its process group on POSIX, and `taskkill /T /F` on Windows, which
 * has no process groups. Requests the client makes of us get the safest answer: a permission
 * request is `cancelled`, anything else is `method not found`.
 */
export async function probeSessionsPerProcess(
  probe: SessionsPerProcessProbe,
): Promise<SessionsPerProcessReport> {
  const timeoutMs = probe.timeoutMs ?? 30_000;
  const child = spawn(probe.cmd, [...(probe.args ?? [])], {
    cwd: probe.cwd,
    env: { ...probe.env },
    // POSIX: a group of its own, for the group kill at the end. Windows: `detached` would open a
    // console of its own and gives no group.
    detached: !WINDOWS,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const state = { alive: true };
  const gone = new Promise<void>((resolve) => {
    child.once('exit', () => {
      state.alive = false;
      resolve();
    });
    child.once('error', () => {
      state.alive = false;
      resolve();
    });
  });
  const pending = new Map<number, (message: Json) => void>();
  let nextId = 0;
  const write = (message: Json): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      pending.get(id)?.(message);
      return;
    }
    if (id === undefined || typeof message.method !== 'string') return;
    // A request of the agent to us.
    if (message.method === 'session/request_permission') {
      write({ id, result: { outcome: { outcome: 'cancelled' } } });
    } else {
      write({ id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  child.stdin.on('error', () => {
    // The process ended under us: the pending call fails by its timeout or by `gone`.
  });

  const request = (method: string, params: Json): Promise<Json> => {
    nextId += 1;
    const id = nextId;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer in ${String(timeoutMs)} ms`));
      }, timeoutMs);
      void gone.then(() => {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`the process ended before ${method} answered`));
      });
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if ('error' in message) reject(new Error(JSON.stringify(message.error).slice(0, 200)));
        else resolve((message.result ?? {}) as Json);
      });
      write({ id, method, params });
    });
  };

  const failures: string[] = [];
  const ids = new Set<string>();
  let accepted = 0;
  let configOptionIds: readonly string[] = [];
  let rssKiB: number | undefined;
  try {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const agentInfo = agentInfoOf(initialized.agentInfo);
    for (let index = 0; index < probe.sessions; index += 1) {
      try {
        const created = await request('session/new', {
          cwd: probe.cwd,
          mcpServers: [],
          ...probe.newParams?.(probe.cwd, index),
        });
        accepted += 1;
        if (typeof created.sessionId === 'string') ids.add(created.sessionId);
        if (accepted === 1) configOptionIds = optionIds(created.configOptions);
      } catch (error) {
        failures.push(`session ${String(index + 1)}: ${(error as Error).message.slice(0, 200)}`);
        // A process that ended cannot take the next one.
        if (!state.alive) break;
      }
    }
    rssKiB = await residentKiB(child.pid);
    return {
      requested: probe.sessions,
      accepted,
      distinctSessionIds: ids.size,
      failures,
      configOptionIds,
      rssKiB,
      processAlive: state.alive,
      agentInfo,
    };
  } finally {
    const pid = child.pid;
    if (pid !== undefined && state.alive) killTreeNow(pid);
    await gone;
  }
}

const WINDOWS = process.platform === 'win32';

/**
 * Forced kill of the tree rooted at `pid`. POSIX: `kill(-pid)` reaches the group the child leads.
 * Windows: a negative pid is not a group there (the kill would throw and leave the process alive),
 * so the system `taskkill /PID <pid> /T /F` ends the root and its descendants.
 */
function killTreeNow(pid: number): void {
  if (WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function agentInfoOf(raw: unknown): SessionsPerProcessReport['agentInfo'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, version } = raw as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return { name: name.slice(0, 100), version: version.slice(0, 64) };
}

function optionIds(options: unknown): readonly string[] {
  if (!Array.isArray(options)) return [];
  const result: string[] = [];
  for (const option of options as unknown[]) {
    const id = (option as { id?: unknown } | null)?.id;
    if (typeof id === 'string') result.push(id);
  }
  return result;
}

async function residentKiB(pid: number | undefined): Promise<number | undefined> {
  if (pid === undefined) return undefined;
  try {
    const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
}

/** One line for the log of a real run, with no environment and no path. */
export function describeSessionsReport(client: string, report: SessionsPerProcessReport): string {
  const rss =
    report.rssKiB === undefined ? 'n/a' : `${String(Math.round(report.rssKiB / 1024))} MiB`;
  return (
    `[sessions-per-process] client=${client} requested=${String(report.requested)} ` +
    `accepted=${String(report.accepted)} distinct_ids=${String(report.distinctSessionIds)} ` +
    `alive=${String(report.processAlive)} rss=${rss}` +
    (report.agentInfo === undefined
      ? ' agent_info=none'
      : ` agent_info=${report.agentInfo.name}@${report.agentInfo.version}`) +
    (report.failures.length === 0 ? '' : ` failures=${JSON.stringify(report.failures)}`)
  );
}

/**
 * K for a real run: `OT_TEST_SESSIONS_PER_PROCESS`, a positive integer, 4 when absent or invalid
 * (the default `pool.sessions_per_process`). [proposta]
 */
export function realSessionsPerProcess(): number {
  const value = Number(process.env.OT_TEST_SESSIONS_PER_PROCESS);
  return Number.isSafeInteger(value) && value >= 1 ? value : 4;
}
