// SPDX-License-Identifier: MPL-2.0
import type { Environment } from './env.js';
import type { ResultA } from './scenario-a.js';
import { METHODS, type ResultB, type SummaryB } from './scenario-b.js';

export interface Results {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly quick: boolean;
  readonly totalSeconds: number;
  readonly environment: Environment;
  readonly scenarioA: ResultA | undefined;
  readonly scenarioB: ResultB | undefined;
}

type Cell = string | number | undefined;

function show(value: Cell, digits = 2): string {
  if (value === undefined) return '-';
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

/** Aligned plain-text table (right-aligned numbers). */
export function textTable(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const cells = rows.map((row) => row.map((cell) => show(cell)));
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const line = (row: readonly string[]): string =>
    row.map((cell, i) => cell.padStart(widths[i] ?? 0)).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join(
    '\n',
  );
}

/** GitHub-flavoured Markdown table. */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map((row) => line(row.map((cell) => show(cell)))),
  ].join('\n');
}

const methodLabel = (id: string): string => METHODS.find((m) => m.id === id)?.label ?? id;

const A_HEADERS = ['driver', 'tx size', 'sync', 'tx/s', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms'];
const A_RATIO_HEADERS = ['driver', 'tx size', 'FULL/NORMAL tx/s', 'FULL/NORMAL p99'];

function tablesA(result: ResultA): { summary: Cell[][]; ratios: Cell[][] } {
  return {
    summary: result.summary.map((s) => [
      s.driver,
      `${String(s.eventsPerTransaction)} ev`,
      s.synchronous.toUpperCase(),
      s.transactionsPerSecond,
      s.p50Ms,
      s.p95Ms,
      s.p99Ms,
      s.maxMs,
    ]),
    ratios: result.ratios.map((r) => [
      r.driver,
      `${String(r.eventsPerTransaction)} ev`,
      r.throughput,
      r.p99,
    ]),
  };
}

const B_HEADERS = [
  'driver',
  'db',
  'writer',
  'method',
  'ok/runs',
  'copy ms',
  'loop max ms',
  'loop p99 ms',
  'writer tx',
  'timer late max ms',
  'restarts (max)',
  'integrity ms',
];

function tableB(summary: readonly SummaryB[]): Cell[][] {
  return summary.map((s) => [
    s.driver,
    s.size,
    s.writer ? 'yes' : 'no',
    methodLabel(s.method),
    `${String(s.finished)}/${String(s.runs)}${s.transient > 0 ? ` (${String(s.transient)} Transient)` : ''}${s.failed > 0 ? ` (${String(s.failed)} failed)` : ''}`,
    s.durationMs,
    s.eventLoopMaxMs,
    s.eventLoopP99Ms,
    s.writerTransactions,
    s.writerWakeLatenessMaxMs,
    s.restartsMax === undefined
      ? undefined
      : `${show(s.restartsMedian, 0)} (${String(s.restartsMax)})`,
    s.integrityCheckMs,
  ]);
}

function environmentLines(env: Environment): string[] {
  return [
    `Node ${env.node} on ${env.platform} ${env.arch}, kernel ${env.kernel}`,
    `CPU ${env.cpuModel} (${String(env.cpuThreads)} threads), RAM ${String(env.ramGiB)} GiB`,
    `Filesystem ${env.filesystem.type}${env.filesystem.options.length > 0 ? ` (${env.filesystem.options.join(', ')})` : ''}, disk ${env.disk.model ?? 'unknown model'}${env.disk.rotational === undefined ? '' : env.disk.rotational ? ' (rotational)' : ' (non-rotational)'}`,
    `better-sqlite3: ${env.drivers['better-sqlite3'].package}, SQLite ${env.drivers['better-sqlite3'].sqlite}`,
    `node-sqlite: ${env.drivers['node-sqlite'].package}, SQLite ${env.drivers['node-sqlite'].sqlite}`,
  ];
}

/** Everything the CLI prints on stdout. */
export function renderText(results: Results): string {
  const out: string[] = [
    'Environment',
    ...environmentLines(results.environment).map((l) => `  ${l}`),
  ];
  if (results.scenarioA !== undefined) {
    const t = tablesA(results.scenarioA);
    out.push(
      '',
      'A. Cost of synchronous=FULL (WAL; medians over the repetitions, max = worst)',
      textTable(A_HEADERS, t.summary),
      '',
      textTable(A_RATIO_HEADERS, t.ratios),
    );
  }
  if (results.scenarioB !== undefined) {
    out.push(
      '',
      `B. Backup methods (databases: ${results.scenarioB.databases.map((d) => `${d.size} = ${String(d.bytes)} bytes`).join(', ')})`,
      textTable(B_HEADERS, tableB(results.scenarioB.summary)),
    );
  }
  out.push('', `Total time: ${String(results.totalSeconds)} s`);
  return out.join('\n');
}

/** The Markdown summary written beside the JSON (English, like the rest of the repository). */
export function renderMarkdown(results: Results): string {
  const out: string[] = [
    '# Store measurements (Phase 1, step 7)',
    '',
    `Generated by \`node tools/bench/dist/cli.js store\`${results.quick ? ' in `--quick` mode (smoke test, not a result)' : ''} on ${results.generatedAt.slice(0, 10)}. Full data: the JSON file beside this one.`,
    '',
    '## Environment',
    '',
    ...environmentLines(results.environment).map((l) => `- ${l}`),
    '',
  ];
  const a = results.scenarioA;
  if (a !== undefined) {
    const t = tablesA(a);
    out.push(
      '## A. Cost of `synchronous=FULL`',
      '',
      `WAL, one writer, no concurrency; every run on a fresh database after ${String(a.config.warmupTransactions)} untimed warm-up transactions. Each run stops after ${String(a.config.maxTransactions)} transactions or ${String(a.config.maxMs / 1000)} s, whichever comes first; ${String(a.config.repetitions)} repetition(s) per combination. Events carry a payload of about ${String(a.config.payloadBytes)} bytes. Columns are medians over the repetitions; \`max\` is the worst transaction of any repetition. "tx size" is events per transaction. Latency is per transaction, from the call to the commit.`,
      '',
      markdownTable(A_HEADERS, t.summary),
      '',
      'Ratio of the medians (FULL over NORMAL). Throughput below 1 and p99 above 1 mean FULL is slower.',
      '',
      markdownTable(A_RATIO_HEADERS, t.ratios),
      '',
    );
  }
  const b = results.scenarioB;
  if (b !== undefined) {
    out.push(
      '## B. Backup methods',
      '',
      `Databases (events of 200 to 2000 bytes, filled in transactions of 1000): ${b.databases.map((d) => `${d.size} = ${String(d.bytes)} bytes, ${String(d.events)} events`).join('; ')}. The store opens as the daemon would (WAL, FULL). "writer: yes" is one transaction of one event (about ${String(b.config.writerPayloadBytes)} bytes) every ~${String(b.config.writerIntervalMs)} ms in the same process, during the copy. ${String(b.config.repetitions)} repetition(s) per combination; the adapter's default \`timeoutMs\` (${String(b.config.backupTimeoutMs)} ms) applies to stepped copies.`,
      '',
      'How to read it:',
      '',
      '- `copy ms` is the whole `backupDatabase` call (copy, `integrity_check` of the copy, rename); median over the runs that finished.',
      '- `loop max ms` and `loop p99 ms` come from `monitorEventLoopDelay` with 1 ms sampling during that call, so an idle loop reads about 1 ms. Max is the worst over the repetitions; p99 is the median.',
      "- `writer tx` is the median number of writer transactions that committed during the call. `timer late max ms` is how late the writer's 5 ms timer fired in the worst case.",
      '- `restarts` is the median (and the maximum) number of times SQLite restarted the online copy because the writer changed the database between steps.',
      '- `integrity ms` is `PRAGMA integrity_check` on the finished copy, timed in a separate pass with `node:sqlite`; the adapter runs the same check synchronously inside every backup.',
      '',
      markdownTable(B_HEADERS, tableB(b.summary)),
      '',
    );
    if (b.skipped > 0) {
      out.push(
        `${String(b.skipped)} run(s) of scenario B were skipped because the time budget ran out.`,
        '',
      );
    }
  }
  out.push(
    '## Limits',
    '',
    '- The copies were written to the page cache and not flushed (the adapter does not `fsync` the backup file), and the source was read from the page cache (it had just been copied into place): cold-cache reads were not measured.',
    '- One machine, one disk, one filesystem. Absolute numbers do not transfer; the ratios and the shape of the behaviour are what to read.',
    "- Both drivers are synchronous in this adapter, so a transaction runs start to finish without yielding; the writer's transaction latency therefore stays small even while the loop is blocked, and the blocking shows in `timer late max ms` and in the event-loop delay instead.",
    '',
  );
  return out.join('\n');
}
