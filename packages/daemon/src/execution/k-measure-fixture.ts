// SPDX-License-Identifier: MPL-2.0
// Shared by the measurement of `K` only (excluded from the build of the package). Pure helpers
// (parsing of `/proc`, the plan of the cells, the TSV and the table) plus the reader of `/proc`
// itself, which a test replaces with a fake.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Architecture 8, Phase 2: "Pools com `K` e `processModel` medidos". The measurement runs through
 * the product (daemon pool, real adapters, real launcher) and reads the cost from `/proc`, Linux
 * only. [N] Written to be run by the owner (N57): nothing here starts a client by itself.
 */

// ---- what a process is ----------------------------------------------------------------------

/** The kinds the report tells apart (the rest is `other`: MCP servers, shells, helpers). */
export const PROCESS_KINDS = [
  'adapter',
  'claude',
  'codex-app-server',
  'opencode',
  'other',
] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

/** `kB` of `/proc/<pid>/smaps_rollup`; `pssKb` is the share of the pages the process shares. */
export interface Memory {
  readonly rssKb: number;
  readonly pssKb: number;
}

export interface ProcStat {
  readonly pid: number;
  /** The executable name the kernel keeps (15 characters at most). */
  readonly comm: string;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
}

/**
 * Parses `/proc/<pid>/stat`: `pid (comm) state ppid pgrp session ...`. `comm` may hold spaces and
 * parentheses, so the split is at the LAST `)`.
 */
export function parseStat(text: string): ProcStat | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  const session = Number(rest[3]);
  if (![pid, ppid, pgrp, session].every(Number.isInteger)) return undefined;
  return { pid, comm: text.slice(open + 1, close), ppid, pgrp, session };
}

/** `Rss` and `Pss` of `/proc/<pid>/smaps_rollup` (kB). `undefined` when either is missing. */
export function parseSmapsRollup(text: string): Memory | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const rssKb = field('Rss');
  const pssKb = field('Pss');
  return rssKb === undefined || pssKb === undefined ? undefined : { rssKb, pssKb };
}

/** `MemAvailable` of `/proc/meminfo`, in MB. */
export function parseMemAvailableMb(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return match?.[1] === undefined ? undefined : Math.floor(Number(match[1]) / 1024);
}

/** The arguments of `/proc/<pid>/cmdline` (separated by NUL). */
export function parseCmdline(text: string): readonly string[] {
  return text.split('\0').filter((part) => part !== '');
}

/**
 * What a process of the tree is, from the name the kernel keeps and its arguments. The adapter of
 * Claude Code and the one of Codex are `node` or a binary that has the package in its arguments
 * or its name; the `claude` child is named `claude`; Codex's `app-server` is `codex ... app-server`;
 * OpenCode is `opencode` itself. [N] Names measured in Phase 0 on this machine (spikes/acp-*);
 * a client that renames its process falls into `other`, and the row says how many there are.
 */
export function classify(comm: string, argv: readonly string[]): ProcessKind {
  const names = [comm, ...argv.slice(0, 3).map((arg) => basename(arg))];
  if (names.some((name) => name === 'claude-agent-acp' || name === 'codex-acp')) return 'adapter';
  if (argv.some((arg) => /claude-agent-acp|codex-acp/.test(arg))) return 'adapter';
  if (comm === 'claude' || basename(argv[0] ?? '') === 'claude') return 'claude';
  if (
    argv.some((arg) => /[/\\]@anthropic-ai[/\\]claude-code[/\\]/.test(arg)) ||
    argv.some((arg) => /[/\\]claude-code[/\\](cli|bin)/.test(arg))
  ) {
    return 'claude';
  }
  if (names.some((name) => name === 'codex') && argv.includes('app-server')) {
    return 'codex-app-server';
  }
  if (names.some((name) => name === 'opencode' || name === '.opencode')) return 'opencode';
  return 'other';
}

// ---- reading /proc --------------------------------------------------------------------------

export type ProcFile = 'stat' | 'cmdline' | 'smaps_rollup';

/** The part of `/proc` the sampler reads. A test hands in a fake. */
export interface ProcFs {
  pids(): readonly number[];
  /** The text of the file, or `undefined` when the process is gone or the file is not readable. */
  read(pid: number, file: ProcFile): string | undefined;
}

/** The real `/proc` (or another root, for a test that builds a small tree on disk). */
export function linuxProcFs(root = '/proc'): ProcFs {
  return {
    pids: () => {
      try {
        return readdirSync(root)
          .filter((name) => /^\d+$/.test(name))
          .map(Number);
      } catch {
        return [];
      }
    },
    read: (pid, file) => {
      try {
        return readFileSync(join(root, String(pid), file), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export interface KindTotals {
  readonly count: number;
  readonly rssKb: number;
  readonly pssKb: number;
}

/** One look at the process tree of the pids a launcher started. */
export interface TreeSample {
  /** Milliseconds since the sampler started (the caller's clock). */
  readonly at: number;
  readonly pids: readonly number[];
  readonly processes: number;
  readonly rssKb: number;
  readonly pssKb: number;
  /** Processes of the tree whose `smaps_rollup` could not be read (counted, with no memory). */
  readonly unreadable: number;
  readonly byKind: Readonly<Record<ProcessKind, KindTotals>>;
}

const NONE: KindTotals = { count: 0, rssKb: 0, pssKb: 0 };

function emptyKinds(): Record<ProcessKind, KindTotals> {
  return { adapter: NONE, claude: NONE, 'codex-app-server': NONE, opencode: NONE, other: NONE };
}

/**
 * Walks the tree of `roots` and adds its memory. A process belongs to the tree when it is a root,
 * a descendant of one by `ppid`, or still in the process group or session of a root (the launcher
 * starts every client with `setsid`, so a grandchild whose parent died and was adopted by init is
 * still found). A root that is gone is simply absent. `at` is the caller's time stamp.
 */
export function sampleTree(fs: ProcFs, roots: readonly number[], at: number): TreeSample {
  const stats = new Map<number, ProcStat>();
  for (const pid of fs.pids()) {
    const text = fs.read(pid, 'stat');
    const stat = text === undefined ? undefined : parseStat(text);
    if (stat !== undefined) stats.set(stat.pid, stat);
  }
  const rootSet = new Set(roots);
  const members = new Set<number>();
  const queue: number[] = [];
  const add = (pid: number): void => {
    if (members.has(pid)) return;
    members.add(pid);
    queue.push(pid);
  };
  for (const stat of stats.values()) {
    if (rootSet.has(stat.pid) || rootSet.has(stat.pgrp) || rootSet.has(stat.session)) add(stat.pid);
  }
  const children = new Map<number, number[]>();
  for (const stat of stats.values()) {
    const list = children.get(stat.ppid) ?? [];
    list.push(stat.pid);
    children.set(stat.ppid, list);
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) add(child);
  }

  const byKind = emptyKinds();
  let rssKb = 0;
  let pssKb = 0;
  let unreadable = 0;
  const pids = [...members].sort((a, b) => a - b);
  for (const pid of pids) {
    const stat = stats.get(pid);
    if (stat === undefined) continue;
    const cmdline = fs.read(pid, 'cmdline');
    const kind = classify(stat.comm, cmdline === undefined ? [] : parseCmdline(cmdline));
    const smaps = fs.read(pid, 'smaps_rollup');
    const memory = smaps === undefined ? undefined : parseSmapsRollup(smaps);
    if (memory === undefined) unreadable += 1;
    const before = byKind[kind];
    byKind[kind] = {
      count: before.count + 1,
      rssKb: before.rssKb + (memory?.rssKb ?? 0),
      pssKb: before.pssKb + (memory?.pssKb ?? 0),
    };
    rssKb += memory?.rssKb ?? 0;
    pssKb += memory?.pssKb ?? 0;
  }
  return { at, pids, processes: pids.length, rssKb, pssKb, unreadable, byKind };
}

/** The sample with the most RSS (the first of them on a tie), for the "peak" of a series. */
export function peakSample(samples: readonly TreeSample[]): TreeSample | undefined {
  let peak: TreeSample | undefined;
  for (const sample of samples) {
    if (peak === undefined || sample.rssKb > peak.rssKb) peak = sample;
  }
  return peak;
}

/** Every pid that showed up in any sample (to look for orphans after the daemon stops). */
export function seenPids(samples: readonly TreeSample[]): readonly number[] {
  return [...new Set(samples.flatMap((sample) => sample.pids))].sort((a, b) => a - b);
}

// ---- the plan -------------------------------------------------------------------------------

/**
 * How the N sessions of a cell are laid over processes:
 * - `single`: N = 1;
 * - `shared`: `pool.sessions_per_process: N`, the N sessions on one adapter process;
 * - `own`: `pool.sessions_per_process: 1`, N processes with one session each;
 * - `per-session`: the adapter itself starts one process per session (`processModel:
 *   'process-per-session'`, Claude Code), so `K` changes nothing and there is one cell per N.
 */
export type Layout = 'single' | 'shared' | 'own' | 'per-session';

export interface Cell {
  readonly n: number;
  /** `pool.sessions_per_process` of this cell. */
  readonly k: number;
  readonly layout: Layout;
  /** How many processes the pool or the adapter should start for these N sessions. */
  readonly expectedRoots: number;
}

/**
 * The cells of one client, by growing N. `sharesProcess` is true for a client whose adapter is
 * `multi-session` under the default config (Codex, OpenCode), false for `process-per-session`
 * (Claude Code).
 */
export function planCells(values: readonly number[], sharesProcess: boolean): readonly Cell[] {
  const cells: Cell[] = [];
  for (const n of values) {
    if (n === 1) cells.push({ n, k: 1, layout: 'single', expectedRoots: 1 });
    else if (!sharesProcess) cells.push({ n, k: 1, layout: 'per-session', expectedRoots: n });
    else {
      cells.push({ n, k: n, layout: 'shared', expectedRoots: 1 });
      cells.push({ n, k: 1, layout: 'own', expectedRoots: n });
    }
  }
  return cells;
}

/** `OT_TEST_K_VALUES`: `1,2,4,6` (default). Sorted, without repeats; whole numbers from 1 to 16. */
export function parseKValues(text: string | undefined): readonly number[] {
  const source = text === undefined || text.trim() === '' ? '1,2,4,6' : text;
  const values = source.split(',').map((part) => part.trim());
  const numbers = values.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 16)) {
    throw new Error(
      `OT_TEST_K_VALUES must be whole numbers from 1 to 16 separated by commas: ${source}`,
    );
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Local time as `YYYYMMDD-HHMMSS`, the stamp the acceptance script puts in its file names. */
export function stampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? high) + high) / 2;
}

// ---- the rows -------------------------------------------------------------------------------

export type Phase = 'idle' | 'prompt';
export type RowStatus = 'ok' | 'skipped' | 'error';

/**
 * One row per client x layout x N x phase. `idle` rows describe the sample taken after the N
 * sessions are open and settled. `prompt` rows describe the sample with the most RSS while the N
 * prompts ran at once (counts and memory come from that one sample; `peakProcesses` and
 * `peakPssMb` are the highest value of each over the whole turn, which can be other samples).
 */
export interface MeasureRow {
  readonly client: string;
  readonly layout: Layout;
  readonly n: number;
  readonly k: number;
  readonly phase: Phase;
  readonly status: RowStatus;
  readonly expectedRoots: number;
  /** Processes the launcher started and that were alive when the sessions were open. */
  readonly foundRoots: number | undefined;
  readonly processes: number | undefined;
  readonly byKind: Readonly<Record<ProcessKind, number>> | undefined;
  readonly rssMb: number | undefined;
  readonly pssMb: number | undefined;
  readonly peakProcesses: number | undefined;
  readonly peakPssMb: number | undefined;
  /** Time to open the N sessions, one after the other. */
  readonly openMs: number | undefined;
  /** Wall time of the N prompts at once. */
  readonly wallMs: number | undefined;
  readonly sessionMsMin: number | undefined;
  readonly sessionMsMedian: number | undefined;
  readonly sessionMsMax: number | undefined;
  /** `end_turn:3 timeout:1`. */
  readonly stopReasons: string | undefined;
  readonly samples: number | undefined;
  readonly note: string;
}

const MB = 1024;

export function mb(kb: number): number {
  return Math.round((kb / MB) * 10) / 10;
}

/** Counts per kind of a sample, for a row. */
export function kindCounts(sample: TreeSample): Record<ProcessKind, number> {
  return {
    adapter: sample.byKind.adapter.count,
    claude: sample.byKind.claude.count,
    'codex-app-server': sample.byKind['codex-app-server'].count,
    opencode: sample.byKind.opencode.count,
    other: sample.byKind.other.count,
  };
}

/** `end_turn:3 timeout:1`, by growing name. */
export function formatStopReasons(reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}:${String(count)}`)
    .join(' ');
}

const TSV_COLUMNS: readonly (readonly [
  string,
  (row: MeasureRow) => string | number | undefined,
])[] = [
  ['client', (r) => r.client],
  ['layout', (r) => r.layout],
  ['n', (r) => r.n],
  ['k', (r) => r.k],
  ['phase', (r) => r.phase],
  ['status', (r) => r.status],
  ['roots_expected', (r) => r.expectedRoots],
  ['roots_found', (r) => r.foundRoots],
  ['processes', (r) => r.processes],
  ['adapter', (r) => r.byKind?.adapter],
  ['claude', (r) => r.byKind?.claude],
  ['codex_app_server', (r) => r.byKind?.['codex-app-server']],
  ['opencode', (r) => r.byKind?.opencode],
  ['other', (r) => r.byKind?.other],
  ['rss_mb', (r) => r.rssMb],
  ['pss_mb', (r) => r.pssMb],
  ['rss_mb_per_session', (r) => (r.rssMb === undefined ? undefined : mb((r.rssMb * MB) / r.n))],
  ['pss_mb_per_session', (r) => (r.pssMb === undefined ? undefined : mb((r.pssMb * MB) / r.n))],
  ['peak_processes', (r) => r.peakProcesses],
  ['peak_pss_mb', (r) => r.peakPssMb],
  ['open_ms', (r) => r.openMs],
  ['wall_ms', (r) => r.wallMs],
  ['session_ms_min', (r) => r.sessionMsMin],
  ['session_ms_median', (r) => r.sessionMsMedian],
  ['session_ms_max', (r) => r.sessionMsMax],
  ['stop_reasons', (r) => r.stopReasons],
  ['samples', (r) => r.samples],
  ['note', (r) => r.note],
];

function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

/** One header line and one line per row, tab separated, ending in a newline. */
export function formatTsv(rows: readonly MeasureRow[]): string {
  const lines = [TSV_COLUMNS.map(([name]) => name).join('\t')];
  for (const row of rows) lines.push(TSV_COLUMNS.map(([, get]) => cell(get(row))).join('\t'));
  return `${lines.join('\n')}\n`;
}

const TABLE_COLUMNS: readonly (readonly [
  string,
  (row: MeasureRow) => string | number | undefined,
])[] = [
  ['client', (r) => r.client],
  ['layout', (r) => r.layout],
  ['N', (r) => r.n],
  ['K', (r) => r.k],
  ['phase', (r) => r.phase],
  ['proc', (r) => r.processes],
  ['adapter', (r) => r.byKind?.adapter],
  ['claude', (r) => r.byKind?.claude],
  ['codex', (r) => r.byKind?.['codex-app-server']],
  ['opencode', (r) => r.byKind?.opencode],
  ['other', (r) => r.byKind?.other],
  ['RSS MB', (r) => r.rssMb],
  ['PSS MB', (r) => r.pssMb],
  ['PSS/sess', (r) => (r.pssMb === undefined ? undefined : mb((r.pssMb * MB) / r.n))],
  ['wall ms', (r) => r.wallMs],
  ['status', (r) => (r.note === '' ? r.status : `${r.status}: ${r.note}`)],
];

/** The rows as an aligned text table (what the test prints). */
export function formatTable(rows: readonly MeasureRow[]): string {
  const grid = [
    TABLE_COLUMNS.map(([name]) => name),
    ...rows.map((row) => TABLE_COLUMNS.map(([, get]) => cell(get(row)))),
  ];
  const widths = TABLE_COLUMNS.map((_, index) =>
    Math.max(...grid.map((line) => (line[index] ?? '').length)),
  );
  const numeric = (index: number): boolean => index >= 2 && index < TABLE_COLUMNS.length - 1;
  const render = (line: readonly string[]): string =>
    line
      .map((text, index) =>
        numeric(index) && index !== 4
          ? text.padStart(widths[index] ?? 0)
          : text.padEnd(widths[index] ?? 0),
      )
      .join('  ')
      .trimEnd();
  const [header, ...body] = grid;
  return `${[render(header ?? []), ...body.map(render)].join('\n')}\n`;
}

// ---- the summary ----------------------------------------------------------------------------

export interface ClientSummary {
  readonly id: string;
  /** The adapter's version after the sessions opened (the `initialize` may have corrected it). */
  readonly adapterVersion: string | undefined;
  /** The client's own version and where it came from (`package_json`, `initialize`...). */
  readonly clientVersion: string | undefined;
  readonly clientVersionSource: string | undefined;
  readonly processModel: string | undefined;
  readonly model: string | undefined;
  readonly mode: string | undefined;
  /** Why the client or its prompt part was left out; `undefined` when it ran in full. */
  readonly left: string | undefined;
}

export interface MeasureSummary {
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
  readonly host: {
    readonly platform: string;
    readonly release: string;
    readonly node: string;
    readonly totalMemMb: number;
    readonly availableAtStartMb: number | undefined;
  };
  readonly settings: {
    readonly kValues: readonly number[];
    readonly settleMs: number;
    readonly sampleEveryMs: number;
    readonly minAvailableMb: number;
    readonly prompts: boolean;
    readonly prompt: string;
  };
  readonly clients: readonly ClientSummary[];
  readonly rows: readonly MeasureRow[];
  /** `[t_ms, processes, rss_mb, pss_mb]` per sample of the prompt phase, by `client/layout/N`. */
  readonly series: Readonly<Record<string, readonly (readonly number[])[]>>;
  /** Problems the test fails on (a layout that is not the one asked for, an orphan). */
  readonly problems: readonly string[];
}
