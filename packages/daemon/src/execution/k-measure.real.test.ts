// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, homedir, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type {
  LaunchedProcess,
  LaunchOptions,
  Profile,
  ProcessLauncher,
  RolePolicy,
} from '@otheater/core';
import { InMemorySecretVault } from '@otheater/core/testing';
import { disposeTestGitIsolation, realClientFlags, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { pathFinder, selectClients, type ClientSelection } from '../clients.js';
import { DEFAULT_CLIENT_EXECUTABLES, defaultLauncher, productionClients } from '../compose.js';
import { parseConfig, type ClientId } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeRepo } from './attempt-fixture.js';
import {
  formatStopReasons,
  formatTable,
  formatTsv,
  kindCounts,
  linuxProcFs,
  mb,
  median,
  parseKValues,
  parseMemAvailableMb,
  peakSample,
  planCells,
  sampleTree,
  seenPids,
  stampOf,
  type Cell,
  type ClientSummary,
  type MeasureRow,
  type MeasureSummary,
  type TreeSample,
} from './k-measure-fixture.js';
import type { SessionLease } from './pool.js';

/**
 * Measurement of `K` and of the `processModel` (architecture 8, Phase 2: "Pools com `K` e
 * `processModel` medidos"), with the REAL clients. Nothing here runs by default: a plain `pnpm
 * test` skips the whole file, so no client is started and no quota is spent.
 *
 * - `OT_TEST_REAL_MEASURE_K=1` turns the file on. It also needs `OT_TEST_REAL_CLIENTS=1` and Linux
 *   (the cost is read from `/proc`); without them the file fails loudly instead of skipping.
 * - Idle part: always. For each client and each cell the daemon pool opens N sessions, each in its
 *   own git worktree of a temporary repo and all on the same profile, waits `OT_TEST_K_SETTLE_MS`
 *   (default 3000) and counts processes, RSS and PSS by kind.
 * - Prompt part: with `OT_TEST_REAL_PROMPTS=1` too. One trivial prompt per session goes out at
 *   once, the tree is sampled every `OT_TEST_K_SAMPLE_MS` (default 250), and the wall time, the
 *   time per session, the stop reasons and the peaks are recorded. This spends quota: a few
 *   dozen short turns per client in all.
 *
 * What the owner points at (the same variables as the acceptance with prompts; a profile is
 * pointed at, never copied, and used as is):
 * - `OT_TEST_CLAUDE_PROFILE_DIR`, `OT_TEST_CODEX_PROFILE_DIR`, `OT_TEST_OPENCODE_PROFILE_DIR`;
 * - with prompts, also `OT_TEST_CLAUDE_MODEL`, `OT_TEST_CODEX_MODEL`, `OT_TEST_OPENCODE_MODEL`
 *   (the model id the client's catalog lists), and optionally the `_MODE` of each one.
 * A client without them is left out, and the log says so.
 *
 * Other knobs: `OT_TEST_K_VALUES` (default `1,2,4,6`, the N of the cells),
 * `OT_TEST_K_MIN_AVAILABLE_MB` (default 1536: the next cell is skipped, and so are the bigger
 * ones, when `MemAvailable` is below it), `OT_TEST_K_OUT_DIR` and `OT_TEST_K_STAMP` (where and
 * under what name the files go; default `$XDG_STATE_HOME/otheater/acceptance/k-measure-<stamp>`).
 *
 * The cells (`planCells`): a client that shares an adapter process (Codex, OpenCode) runs each N
 * above 1 twice, `shared` (`pool.sessions_per_process: N`, one process) and `own`
 * (`pool.sessions_per_process: 1`, N processes); Claude Code is `process-per-session`, so `K`
 * changes nothing and each N runs once. [V] Measured by reading `/proc`, per process tree of the
 * pids the daemon's launcher started. [N] Not run by the agent that wrote it (N57).
 *
 * The sessions are opened one after the other on purpose: [V] concurrent `pool.acquire` calls on
 * a multi-session adapter can each launch a process (the find-then-launch of the pool awaits
 * between the two), so the layout would not be the one asked for. The test records the processes
 * the pool really started (`roots_found`) against the expected ones and fails on a mismatch.
 */

const flags = realClientFlags();
const linux = process.platform === 'linux';
const enabled = flags.measureK && flags.clients && linux;

const PROMPT = 'Reply with the single word ok. Do not use tools.';
/** The turn of one cell that does not end by itself in this time is recorded as `timeout`. */
const PROMPT_TIMEOUT_MS = 120_000;
const RELEASE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 40 * 60_000;
const ORPHAN_WAIT_MS = 3_000;

const PROFILE_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_PROFILE_DIR',
  codex: 'OT_TEST_CODEX_PROFILE_DIR',
  opencode: 'OT_TEST_OPENCODE_PROFILE_DIR',
};
const MODEL_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_MODEL',
  codex: 'OT_TEST_CODEX_MODEL',
  opencode: 'OT_TEST_OPENCODE_MODEL',
};
const MODE_ENV: Readonly<Record<ClientId, string>> = {
  'claude-code': 'OT_TEST_CLAUDE_MODE',
  codex: 'OT_TEST_CODEX_MODE',
  opencode: 'OT_TEST_OPENCODE_MODE',
};

/**
 * Whether the client's adapter shares a process between sessions under the config the cells use
 * (Claude Code is fixed `process-per-session`; Codex `multi-session`; OpenCode `per_profile`).
 * Checked against `adapter.processModel` of the real adapter before any cell runs.
 */
const SHARES_PROCESS: Readonly<Record<ClientId, boolean>> = {
  'claude-code': false,
  codex: true,
  opencode: true,
};

const READ_ONLY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

afterAll(disposeTestGitIsolation);

function value(name: string): string | undefined {
  const text = process.env[name];
  return text === undefined || text === '' ? undefined : text;
}

function numberFrom(name: string, fallback: number): number {
  const text = value(name);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole number of at least 0: ${text}`);
  }
  return parsed;
}

function log(text: string): void {
  // `console.log` of a passing test is hidden by vitest; stderr is not.
  process.stderr.write(`[k-measure] ${text}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settles with `undefined` after `ms` when `work` has not ended (the work itself is not stopped). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A launcher that remembers the pid of every process it starts: the roots of the trees. */
function recording(inner: ProcessLauncher): { launcher: ProcessLauncher; pids: number[] } {
  const pids: number[] = [];
  const launcher: ProcessLauncher = {
    id: inner.id,
    implements: inner.implements,
    capabilities: () => inner.capabilities(),
    launch: async (options: LaunchOptions): Promise<LaunchedProcess> => {
      const launched = await inner.launch(options);
      pids.push(launched.pid);
      return launched;
    },
  };
  return { launcher, pids };
}

function availableMb(): number | undefined {
  try {
    return parseMemAvailableMb(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return undefined;
  }
}

function outDir(): string {
  const explicit = value('OT_TEST_K_OUT_DIR') ?? value('OT_ACCEPT_LOG_DIR');
  if (explicit !== undefined) return explicit;
  const state = value('XDG_STATE_HOME') ?? join(homedir(), '.local', 'state');
  return join(state, 'otheater', 'acceptance');
}

// ---- the run's state --------------------------------------------------------------------------

const kValues = enabled ? parseKValues(process.env.OT_TEST_K_VALUES) : [];
const settleMs = numberFrom('OT_TEST_K_SETTLE_MS', 3_000);
const sampleEveryMs = Math.max(50, numberFrom('OT_TEST_K_SAMPLE_MS', 250));
const minAvailableMb = numberFrom('OT_TEST_K_MIN_AVAILABLE_MB', 1_536);
const promptsOn = flags.prompts;
const stamp = value('OT_TEST_K_STAMP') ?? stampOf(new Date());
const startedAt = new Date().toISOString();

const rows: MeasureRow[] = [];
const series: Record<string, readonly (readonly number[])[]> = {};
const problems: string[] = [];
const summaries = new Map<string, ClientSummary>();
let availableAtStartMb: number | undefined;

/** The clients the daemon's own search finds in PATH (no process is started to ask). */
const found: readonly ClientSelection[] = enabled
  ? selectClients(
      parseConfig('backup:\n  when: manual\n'),
      DEFAULT_CLIENT_EXECUTABLES,
      pathFinder(process.env),
    ).filter((selection) => selection.enabled)
  : [];

/** Why a client cannot take part, or `undefined` when it can. */
function leftOutReason(id: ClientId): string | undefined {
  const missing = [PROFILE_ENV[id], ...(promptsOn ? [MODEL_ENV[id]] : [])].filter(
    (name) => value(name) === undefined,
  );
  return missing.length === 0 ? undefined : `left out: set ${missing.join(' and ')}`;
}

async function writeOutputs(finished: boolean): Promise<string> {
  const summary: MeasureSummary = {
    startedAt,
    finishedAt: finished ? new Date().toISOString() : undefined,
    host: {
      platform: `${process.platform}-${arch()}`,
      release: release(),
      node: process.version,
      totalMemMb: Math.round(totalmem() / (1024 * 1024)),
      availableAtStartMb,
    },
    settings: {
      kValues,
      settleMs,
      sampleEveryMs,
      minAvailableMb,
      prompts: promptsOn,
      prompt: PROMPT,
    },
    clients: [...summaries.values()],
    rows,
    series,
    problems,
  };
  const dir = outDir();
  await mkdir(dir, { recursive: true });
  const base = join(dir, `k-measure-${stamp}`);
  await writeFile(`${base}.tsv`, formatTsv(rows));
  await writeFile(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(`${base}.txt`, formatTable(rows));
  return base;
}

// ---- one cell ----------------------------------------------------------------------------------

interface CellOutcome {
  readonly rows: MeasureRow[];
  readonly problems: string[];
  readonly series: readonly (readonly number[])[] | undefined;
  readonly versions: Pick<
    ClientSummary,
    'adapterVersion' | 'clientVersion' | 'clientVersionSource' | 'processModel'
  >;
}

function blankRow(
  client: string,
  cell: Cell,
  phase: MeasureRow['phase'],
  status: MeasureRow['status'],
  note: string,
): MeasureRow {
  return {
    client,
    layout: cell.layout,
    n: cell.n,
    k: cell.k,
    phase,
    status,
    expectedRoots: cell.expectedRoots,
    foundRoots: undefined,
    processes: undefined,
    byKind: undefined,
    rssMb: undefined,
    pssMb: undefined,
    peakProcesses: undefined,
    peakPssMb: undefined,
    openMs: undefined,
    wallMs: undefined,
    sessionMsMin: undefined,
    sessionMsMedian: undefined,
    sessionMsMax: undefined,
    stopReasons: undefined,
    samples: undefined,
    note,
  };
}

function configOf(cell: Cell) {
  return parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
clients:
  codex:
    process_model: multi-session
pool:
  sessions_per_process: ${String(cell.k)}
  max_sessions: ${String(cell.n)}
  opencode:
    process_model: per_profile
resume:
  checkpoint_edit_batch: 1
  checkpoint_every: 5m
`);
}

/** The version of a client's adapter and of the client itself, as the adapter reports them now. */
function versionsOf(adapter: object): CellOutcome['versions'] {
  const record = adapter as {
    adapterVersion?: unknown;
    processModel?: unknown;
    clientVersion?: { version?: unknown; source?: unknown };
  };
  const text = (input: unknown): string | undefined =>
    typeof input === 'string' ? input : undefined;
  return {
    adapterVersion: text(record.adapterVersion),
    clientVersion: text(record.clientVersion?.version),
    clientVersionSource: text(record.clientVersion?.source),
    processModel: text(record.processModel),
  };
}

async function runCell(selection: ClientSelection, cell: Cell): Promise<CellOutcome> {
  const id = selection.id;
  const model = value(MODEL_ENV[id]);
  const mode = value(MODE_ENV[id]);
  const withPrompts = promptsOn && model !== undefined;
  const label = `${id}/${cell.layout}/N=${String(cell.n)}`;
  const cellRows: MeasureRow[] = [];
  const cellProblems: string[] = [];
  let cellSeries: readonly (readonly number[])[] | undefined;
  let versions: CellOutcome['versions'] = {
    adapterVersion: undefined,
    clientVersion: undefined,
    clientVersionSource: undefined,
    processModel: undefined,
  };

  const tmp = await makeTempDataDir();
  const root = await mkdtemp(join(tmpdir(), 'otheater-kmeasure-'));
  const { repo, dispose: disposeRepo } = await makeRepo();
  const real = defaultLauncher();
  if (real === undefined) throw new Error('this platform has no process launcher');
  const { launcher, pids } = recording(real);
  const config = configOf(cell);
  const daemon = await startDaemon({
    dataDir: tmp.dir,
    config,
    // The system clock: the deadline of the attempt (`timeoutMs`) sleeps on it, and a fake one never wakes.
    overrides: { vault: new InMemorySecretVault(), launcher },
    clients: productionClients(config),
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
  const profile: Profile = {
    client: id,
    profile: 'real',
    id: `${id}/real`,
    dir: value(PROFILE_ENV[id]) ?? join(root, 'profiles', id),
  };
  const procFs = linuxProcFs();
  const leases: SessionLease[] = [];
  const seen: TreeSample[] = [];
  const t0 = Date.now();
  const sampleNow = (): TreeSample => {
    const sample = sampleTree(procFs, pids, Date.now() - t0);
    seen.push(sample);
    return sample;
  };
  let hung = false;

  try {
    const execution = daemon.execution;
    if (execution === undefined) throw new Error('the daemon has no execution');
    const pool = execution.pool;
    const adapter = pool.adapterOf(id);
    const shares = adapter.processModel === 'multi-session';
    if (shares !== SHARES_PROCESS[id]) {
      throw new Error(
        `${id}: the adapter is ${adapter.processModel} but the plan assumed ${SHARES_PROCESS[id] ? 'multi-session' : 'process-per-session'}`,
      );
    }

    // ---- open N sessions, one after the other, each in its own worktree ----
    const openStart = Date.now();
    for (let index = 0; index < cell.n; index += 1) {
      const cwd = join(root, 'worktrees', String(index));
      await testGit(repo, 'worktree', 'add', '--quiet', '-b', `k-${String(index)}`, cwd, 'main');
      leases.push(await pool.acquire({ client: id, profile, policy: READ_ONLY, cwd }));
    }
    const openMs = Date.now() - openStart;
    if (withPrompts) {
      const want = { model, ...(mode === undefined ? {} : { mode }) };
      const options = adapter.configOptionsFor(want);
      for (const lease of leases) {
        for (const [optionId, optionValue] of Object.entries(options)) {
          await lease.session.setConfig(optionId, optionValue);
        }
      }
    }
    versions = versionsOf(adapter);

    const foundRoots = pids.filter(alive).length;
    const layoutOk = foundRoots === cell.expectedRoots;
    if (!layoutOk) {
      cellProblems.push(
        `${label}: the layout is not the one asked for: ${String(foundRoots)} process(es) started, ${String(cell.expectedRoots)} expected`,
      );
    }
    const layoutNote = layoutOk ? '' : `layout mismatch: ${String(foundRoots)} roots`;

    // ---- idle ----
    await sleep(settleMs);
    const idle = sampleNow();
    cellRows.push({
      ...blankRow(id, cell, 'idle', 'ok', layoutNote),
      foundRoots,
      processes: idle.processes,
      byKind: kindCounts(idle),
      rssMb: mb(idle.rssKb),
      pssMb: mb(idle.pssKb),
      peakProcesses: idle.processes,
      peakPssMb: mb(idle.pssKb),
      openMs,
      samples: 1,
    });
    log(
      `${label} idle: ${String(idle.processes)} processes, RSS ${String(mb(idle.rssKb))} MB, PSS ${String(mb(idle.pssKb))} MB`,
    );

    // ---- prompts, all at once ----
    if (withPrompts) {
      const samples: TreeSample[] = [];
      const take = (): void => {
        const sample = sampleNow();
        samples.push(sample);
      };
      const promptStart = Date.now();
      const reasons: string[] = [];
      const times: number[] = [];
      const failures: string[] = [];
      take();
      const timer = setInterval(take, sampleEveryMs);
      const turns = leases.map(async (lease) => {
        const begun = Date.now();
        try {
          const outcome = await lease.session.prompt([{ type: 'text', text: PROMPT }]);
          reasons.push(outcome.stopReason);
        } catch (error) {
          reasons.push('error');
          failures.push(error instanceof Error ? error.message : String(error));
        }
        times.push(Date.now() - begun);
      });
      const finished = await within(Promise.all(turns), PROMPT_TIMEOUT_MS);
      clearInterval(timer);
      take();
      const wallMs = Date.now() - promptStart;
      if (finished === undefined) {
        hung = true;
        for (let missing = reasons.length; missing < cell.n; missing += 1) reasons.push('timeout');
      }
      const peak = peakSample(samples) ?? idle;
      const failed = reasons.filter((reason) => reason === 'error' || reason === 'timeout').length;
      const notes = [
        layoutNote,
        failed > 0 ? `${String(failed)} turn(s) failed` : '',
        ...failures.slice(0, 2).map((text) => text.slice(0, 120)),
      ].filter((text) => text !== '');
      if (failed > 0)
        cellProblems.push(`${label}: ${String(failed)} prompt(s) did not end in a stop reason`);
      cellRows.push({
        ...blankRow(id, cell, 'prompt', failed > 0 ? 'error' : 'ok', notes.join('; ')),
        foundRoots,
        processes: peak.processes,
        byKind: kindCounts(peak),
        rssMb: mb(peak.rssKb),
        pssMb: mb(peak.pssKb),
        peakProcesses: Math.max(...samples.map((sample) => sample.processes)),
        peakPssMb: mb(Math.max(...samples.map((sample) => sample.pssKb))),
        openMs,
        wallMs,
        sessionMsMin: times.length === 0 ? undefined : Math.min(...times),
        sessionMsMedian: median(times),
        sessionMsMax: times.length === 0 ? undefined : Math.max(...times),
        stopReasons: formatStopReasons(reasons),
        samples: samples.length,
      });
      cellSeries = samples.map((sample) => [
        sample.at,
        sample.processes,
        mb(sample.rssKb),
        mb(sample.pssKb),
      ]);
      log(
        `${label} prompts: wall ${String(wallMs)} ms, stop reasons ${formatStopReasons(reasons)}, peak ${String(mb(peak.rssKb))} MB RSS`,
      );
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    cellProblems.push(`${label}: ${text}`);
    cellRows.push(blankRow(id, cell, 'idle', 'error', text.slice(0, 200)));
    hung = true;
  } finally {
    // A turn that never ended is not released politely: stopping the daemon kills the process.
    if (!hung) {
      await within(Promise.allSettled(leases.map((lease) => lease.release())), RELEASE_TIMEOUT_MS);
    }
    await daemon.stop();
    await tmp.dispose();
    await disposeRepo();
    await rm(root, { recursive: true, force: true });
    // Nothing the cell started stays: the roots and every process seen in a sample.
    const everyPid = [...new Set([...pids, ...seenPids(seen)])];
    const limit = Date.now() + ORPHAN_WAIT_MS;
    while (everyPid.some(alive) && Date.now() < limit) await sleep(100);
    const left = everyPid.filter(alive);
    if (left.length > 0) {
      cellProblems.push(`${label}: processes left after the daemon stopped: ${left.join(' ')}`);
      for (const pid of pids.filter(alive)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The group is gone or the pid is not a group leader: nothing to do.
        }
      }
    }
  }
  return { rows: cellRows, problems: cellProblems, series: cellSeries, versions };
}

// ---- the test -----------------------------------------------------------------------------------

describe.runIf(flags.measureK && !(flags.clients && linux))(
  'k-measure: precondition (OT_TEST_REAL_MEASURE_K=1)',
  () => {
    it('needs OT_TEST_REAL_CLIENTS=1 and Linux', () => {
      expect.fail(
        'OT_TEST_REAL_MEASURE_K=1 also needs OT_TEST_REAL_CLIENTS=1 and Linux (the cost is read from /proc)',
      );
    });
  },
);

describe.skipIf(!enabled)(
  'real clients: K and processModel measured (OT_TEST_REAL_MEASURE_K=1)',
  () => {
    afterAll(async () => {
      const base = await writeOutputs(true);
      log(`files: ${base}.tsv ${base}.json ${base}.txt`);
    });

    it('finds at least one client in PATH', () => {
      availableAtStartMb = availableMb();
      log(`MemAvailable at start: ${String(availableAtStartMb ?? 'unknown')} MB`);
      expect(
        found.map((selection) => selection.id),
        'none of claude-agent-acp, codex-acp or opencode is in PATH (or clients.<id>.enabled is off)',
      ).not.toHaveLength(0);
    });

    it.each(found.map((selection) => [selection.id, selection] as const))(
      '%s: N sessions in a pool, idle and with prompts, for each layout',
      async (id, selection) => {
        const reason = leftOutReason(id);
        const summary = (extra: Partial<ClientSummary>): ClientSummary => ({
          id,
          adapterVersion: undefined,
          clientVersion: undefined,
          clientVersionSource: undefined,
          processModel: undefined,
          model: promptsOn ? value(MODEL_ENV[id]) : undefined,
          mode: promptsOn ? value(MODE_ENV[id]) : undefined,
          left: undefined,
          ...extra,
        });
        if (reason !== undefined) {
          log(`[${id}] ${reason}`);
          summaries.set(id, summary({ left: reason }));
          return;
        }
        const cells = planCells(kValues, SHARES_PROCESS[id]);
        let tripped: number | undefined;
        let versions: CellOutcome['versions'] | undefined;
        for (const cell of cells) {
          if (tripped === undefined) {
            const free = availableMb();
            if (free !== undefined && free < minAvailableMb) {
              tripped = cell.n;
              log(
                `[${id}] MemAvailable ${String(free)} MB is below ${String(minAvailableMb)} MB: skipping N=${String(cell.n)} and the bigger ones`,
              );
            }
          }
          if (tripped !== undefined) {
            rows.push(
              blankRow(
                id,
                cell,
                'idle',
                'skipped',
                `MemAvailable below ${String(minAvailableMb)} MB`,
              ),
            );
            continue;
          }
          log(`[${id}] cell ${cell.layout} N=${String(cell.n)} K=${String(cell.k)}`);
          const outcome = await runCell(selection, cell);
          rows.push(...outcome.rows);
          problems.push(...outcome.problems);
          if (outcome.series !== undefined) {
            series[`${id}/${cell.layout}/${String(cell.n)}`] = outcome.series;
          }
          if (outcome.versions.adapterVersion !== undefined) versions = outcome.versions;
          summaries.set(id, summary({ ...(versions ?? {}) }));
          await writeOutputs(false);
        }
        summaries.set(id, summary({ ...(versions ?? {}) }));
        process.stderr.write(`\n${formatTable(rows.filter((row) => row.client === id))}\n`);
        expect(problems.filter((text) => text.startsWith(`${id}/`))).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it('left no problem anywhere', () => {
      expect(problems).toEqual([]);
    });
  },
);
